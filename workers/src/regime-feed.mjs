// regime-feed.mjs — E11-T02: fetch the four regime reference indices.
// Workers are allowed outbound fetch; the Go watcher is NOT (market-intake only).
// Every fetch is bounded and fail-soft: a missing index => null => regime UNKNOWN
// => regime.mjs fail-closes (VETO for altcoins, SAFE-001).
//
// Index map:
//   ETHBTC   -> exchange pair (Toobit, then OKX, then Binance klines), with a
//               CoinGecko ETH/BTC ratio as the last-resort fallback
//   USDT.D   -> USDT dominance estimate (CoinGecko markets: supply-weighted)
//   BTC.D    -> BTC dominance estimate (CoinGecko markets: supply-weighted)
//   TOTAL3   -> altcoin market cap estimate (CoinGecko markets: total − BTC − ETH)
//
// Shape: { ETHBTC: string[] | null, USDT.D: string[] | null, BTC.D: string[] | null, TOTAL3: string[] | null }
// Each value is oldest-first CLOSE prices (decimal strings), last = current.
//
// WHY SPARKLINES: dominance has no kline endpoint on the public APIs we use. The
// CoinGecko markets payload carries a 7-day HOURLY `sparkline_in_7d.price` series
// per coin, so multiplying by circulating supply gives a per-bar market cap. The
// sum across the top 250 approximates total cap, and the ratios give BTC.D /
// USDT.D / TOTAL3 with real history (not a single point), which is what the
// EMA-50 comparison needs. These are ESTIMATES of the top-250 universe — labelled
// as such in the run output — but their trend is measurable, and a missing
// sparkline still yields null (UNKNOWN), never an invented value.

const FETCH_TIMEOUT_MS = 6000;
const EMA_PERIOD = 50;
const MIN_BARS = EMA_PERIOD + 2; // need history + current bar

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => { throw new Error("timeout"); })]);

const json = (url, headers = {}) =>
  withTimeout(fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }), FETCH_TIMEOUT_MS)
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });

// ---- ETHBTC from exchange klines (Toobit -> OKX -> Binance) ----
const toobitKlines = (sym) => json(`https://api.toobit.com/quote/v1/klines?symbol=${sym}&interval=1h&limit=120`)
  .then((arr) => Array.isArray(arr) ? arr.map((c) => String(c[4] ?? c.close ?? c)).filter(Boolean) : null);

const okxKlines = (sym) => {
  const inst = sym.replace("USDT", "-USDT"); // ETHBTC -> ETH-BTC (OKX uses - for alts)
  return json(`https://www.okx.com/api/v5/market/candles?instId=${inst}&bar=1H&limit=120`)
    .then((r) => {
      const data = r.data ?? r;
      return Array.isArray(data) ? data.map((c) => String(c[4])).reverse().filter(Boolean) : null; // OKX newest-first
    });
};

const binanceKlines = (sym) =>
  json(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=1h&limit=120`)
    .then((arr) => Array.isArray(arr) ? arr.map((c) => String(c[4])).filter(Boolean) : null);

const fetchEthbtcCloses = async () => {
  for (const fn of [toobitKlines, okxKlines, binanceKlines]) {
    try { const c = await fn("ETHBTC"); if (c && c.length >= MIN_BARS) return c; } catch { /* try next */ }
  }
  return null;
};

// ---- Dominance / market-cap estimates via CoinGecko (no API key, public) ----
// These are estimates over the top-250 universe; if CoinGecko is unreachable the
// indices stay null (UNKNOWN) and regime.mjs fail-closes.
// One call (cached per isolate) carries every coin's circulating supply AND its
// 7d hourly price sparkline — enough to build supply-weighted cap history.
let marketsCache = { ts: 0, data: null };
const coingeckoMarkets = async () => {
  const now = Date.now();
  if (marketsCache.data && now - marketsCache.ts < 300_000) return marketsCache.data;
  try {
    const r = await json(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=true`);
    // Never cache a non-array (an error envelope); serving stale rows is better.
    if (!Array.isArray(r)) return marketsCache.data ?? null;
    marketsCache = { ts: now, data: r };
    return r;
  } catch { return marketsCache.data; } // serve stale cache on outage
};

/** priceHistory — the 7d hourly sparkline as numbers (oldest-first), or null.
 *  A row without at least MIN_BARS usable points contributes nothing: a short
 *  series cannot form an EMA-50, and guessing the missing bars would be fake data. */
const priceHistory = (row) => {
  const p = row?.sparkline_in_7d?.price;
  if (!Array.isArray(p) || p.length < MIN_BARS) return null;
  // `Number(null)` is 0, so a null bar must be rejected explicitly — otherwise an
  // incomplete payload would be read as a real 0-dollar close.
  const nums = p.map((v) => (v === null || v === undefined || v === "" ? NaN : Number(v)));
  return nums.every(Number.isFinite) ? nums : null;
};

/** supplyOf — circulating supply; falls back to market_cap / price. */
const supplyOf = (row) => {
  const s = Number(row?.circulating_supply);
  if (Number.isFinite(s) && s > 0) return s;
  const cap = Number(row?.market_cap), px = Number(row?.current_price);
  return Number.isFinite(cap) && cap > 0 && Number.isFinite(px) && px > 0 ? cap / px : null;
};

/** buildIndexSeries — pure: CoinGecko market rows -> the three cap-based index
 *  series (+ an ETH/BTC ratio used only when the exchange klines are down).
 *
 *  Every series is aligned by taking the NEWEST n bars from each coin (n = the
 *  shortest usable window), so a coin with a slightly shorter sparkline cannot
 *  shift the totals onto the wrong timestamp. Any unusable row is dropped; if
 *  BTC, ETH or USDT itself is unusable the result is null (fail closed) because
 *  dominance cannot be approximated without a numerator. */
export function buildIndexSeries(rows) {
  const empty = { ETHBTC: null, "USDT.D": null, "BTC.D": null, TOTAL3: null };
  if (!Array.isArray(rows) || rows.length < 3) return empty;
  const bySym = (sym) => rows.find((r) => String(r?.symbol).toLowerCase() === sym);
  const btc = bySym("btc"), eth = bySym("eth"), usdt = bySym("usdt");
  const btcP = priceHistory(btc), ethP = priceHistory(eth), usdtP = priceHistory(usdt);
  const btcS = supplyOf(btc), ethS = supplyOf(eth), usdtS = supplyOf(usdt);
  if (!btcP || !ethP || !usdtP || !btcS || !ethS || !usdtS) return empty;

  const coins = rows
    .map((r) => ({ prices: priceHistory(r), supply: supplyOf(r) }))
    .filter((c) => c.prices && c.supply);
  if (coins.length < 3) return empty;

  const n = Math.min(...coins.map((c) => c.prices.length));
  if (n < MIN_BARS) return empty;
  const tail = (p) => p.slice(p.length - n);
  const caps = coins.map((c) => ({ p: tail(c.prices), s: c.supply }));
  const bt = tail(btcP), et = tail(ethP), ut = tail(usdtP);

  const ethbtc = [], btcD = [], usdtD = [], total3 = [];
  for (let i = 0; i < n; i++) {
    let total = 0;
    for (const c of caps) total += c.p[i] * c.s;
    const b = bt[i] * btcS, e = et[i] * ethS, u = ut[i] * usdtS;
    // A zero/negative bar means the payload was not usable — fail closed rather
    // than emit Infinity as a "close".
    if (!(total > 0) || !(bt[i] > 0) || !(et[i] > 0) || !Number.isFinite(b) || !Number.isFinite(u)) return empty;
    ethbtc.push(String(et[i] / bt[i]));
    btcD.push(String(b / total));
    usdtD.push(String(u / total));
    total3.push(String(Math.max(0, total - b - e)));
  }
  return { ETHBTC: ethbtc, "BTC.D": btcD, "USDT.D": usdtD, TOTAL3: total3 };
}

export const fetchRegimeIndices = async () => {
  // Both fetches are independent and each is bounded; either may fail to null.
  const [ethbtc, rows] = await Promise.all([
    fetchEthbtcCloses().catch(() => null),
    coingeckoMarkets().catch(() => null),
  ]);
  const cg = buildIndexSeries(rows ?? []);
  return {
    // The exchange pair is the trading-venue truth; the CG ratio is a labelled
    // fallback so a venue outage degrades to "still measurable", not UNKNOWN.
    ETHBTC: ethbtc ?? cg.ETHBTC,
    "USDT.D": cg["USDT.D"],
    "BTC.D": cg["BTC.D"],
    TOTAL3: cg.TOTAL3,
    // Provenance travels with the series into the analysis run (docs/08 §8.2a):
    // "exchange-klines" is the venue pair, "coingecko-estimate" is the
    // supply-weighted top-250 approximation.
    sources: {
      ETHBTC: ethbtc ? "exchange-klines" : cg.ETHBTC ? "coingecko-estimate" : null,
      "USDT.D": cg["USDT.D"] ? "coingecko-estimate" : null,
      "BTC.D": cg["BTC.D"] ? "coingecko-estimate" : null,
      TOTAL3: cg.TOTAL3 ? "coingecko-estimate" : null,
    },
  };
};

// convenience: latest close of an index (or null)
export const latestClose = (series) =>
  Array.isArray(series) && series.length > 0 ? series[series.length - 1] : null;
