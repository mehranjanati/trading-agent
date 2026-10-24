// regime-feed.mjs — E11-T02: fetch the four regime reference indices.
// Workers are allowed outbound fetch; the Go watcher is NOT (market-intake only).
// Every fetch is bounded and fail-soft: a missing index => null => regime UNKNOWN
// => regime.mjs fail-closes (VETO for altcoins, SAFE-001).
//
// Index map:
//   ETHBTC   -> exchange pair (Toobit, then OKX, then Binance klines)
//   USDT.D   -> USDT dominance estimate (CoinGecko markets / fallback null)
//   BTC.D    -> BTC dominance estimate (CoinGecko markets / fallback null)
//   TOTAL3   -> altcoin market cap estimate (CoinGecko / fallback null)
//
// Shape: { ETHBTC: string[] | null, USDT.D: string[] | null, BTC.D: string[] | null, TOTAL3: string[] | null }
// Each value is oldest-first CLOSE prices (decimal strings), last = current.

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
// These are estimates; if CoinGecko is unreachable the index stays null (UNKNOWN).
const coingecko = async (id) => {
  const r = await json(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`);
  return r?.[id]?.usd ?? null;
};

// Dominance is not a direct CG endpoint; we estimate from BTC/ETH market-cap share
// using /coins/markets (one call, cached per isolate). Best-effort only.
let marketsCache = { ts: 0, data: null };
const coingeckoMarkets = async () => {
  const now = Date.now();
  if (marketsCache.data && now - marketsCache.ts < 300_000) return marketsCache.data;
  try {
    const r = await json(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=false`);
    marketsCache = { ts: now, data: r };
    return r;
  } catch { return marketsCache.data; } // serve stale cache on outage
};

const dominanceShare = async (symbol) => {
  const rows = await coingeckoMarkets();
  if (!rows) return null;
  const btc = rows.find((x) => x.symbol === "btc");
  const eth = rows.find((x) => x.symbol === "eth");
  const total = rows.reduce((s, x) => s + (Number(x.market_cap) || 0), 0);
  if (!total || total <= 0) return null;
  const share = symbol === "BTC" ? (Number(btc?.market_cap) || 0) / total : (Number(eth?.market_cap) || 0) / total;
  // Return as a "close" series of length 1 (current estimate). regime.mjs needs
  // >= MIN_BARS for EMA, so a single point yields UNKNOWN — which is correct:
  // we do not have a 50-bar history for dominance from CG, so fail-closed.
  return null; // dominance has no 1h history here -> UNKNOWN -> fail closed
};

// TOTAL3 ~ altcoin market cap = total - BTC - ETH.
const total3Estimate = async () => {
  const rows = await coingeckoMarkets();
  if (!rows) return null;
  const total = rows.reduce((s, x) => s + (Number(x.market_cap) || 0), 0);
  const btc = rows.find((x) => x.symbol === "btc")?.market_cap ?? 0;
  const eth = rows.find((x) => x.symbol === "eth")?.market_cap ?? 0;
  const t3 = Math.max(0, total - btc - eth);
  // No history => UNKNOWN (fail closed), consistent with dominance above.
  return null;
};

export const fetchRegimeIndices = async () => {
  const [ethbtc] = await Promise.all([fetchEthbtcCloses()]);
  // Dominance/TOTAL3 have no bar history available in this MVP -> null (UNKNOWN).
  // This is intentional fail-closed behaviour; wire real index feeds later.
  return {
    ETHBTC: ethbtc,
    "USDT.D": null,
    "BTC.D": null,
    TOTAL3: null,
  };
};

// convenience: latest close of an index (or null)
export const latestClose = (series) =>
  Array.isArray(series) && series.length > 0 ? series[series.length - 1] : null;
