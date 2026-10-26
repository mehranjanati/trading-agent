// regime.mjs — E11-T01: pure market-regime detector (docs/08-style fail-closed gate).
//
// Input:  { symbol, direction, prices: { ETHBTC?, USDT.D?, BTC.D?, TOTAL3? },
//          config: { regime: { enabled, veto_altcoin_long[], veto_altcoin_short[],
//                            veto_btc_long[], veto_btc_short[], action_on_veto,
//                            confidence_penalty } } }
// Output: { regime: BULLISH|BEARISH|CHOP|UNKNOWN,
//          verdict: PASS|VETO|WARN,
//          reason: string,
//          confidence_penalty: number (0..1),
//          detail: { index_trend: {...}, vetoed_by: string|null } }
//
// RULES (MVP):
//   - Each reference index is compared to its EMA-50: close > EMA => BULLISH,
//     close < EMA => BEARISH, missing => UNKNOWN.
//   - >2 BULLISH among available indices => regime BULLISH.
//   - >2 BEARISH among available indices => regime BEARISH.
//   - Otherwise => CHOP. If ALL indices missing => UNKNOWN.
//   - Veto table (first match wins):
//       altcoin LONG  + BEARISH|UNKNOWN  => VETO  (veto_altcoin_long)
//       altcoin SHORT + BULLISH|UNKNOWN  => VETO  (veto_altcoin_short)
//       BTC LONG      + UNKNOWN          => VETO  (veto_btc_long)
//       BTC SHORT     + UNKNOWN          => VETO  (veto_btc_short)
//   - WARN (not a veto): regime CHOP or regime UNKNOWN => confidence is reduced
//     by confidence_penalty, trade still allowed.
//   - action_on_veto = BLOCK => bias forced FLAT. WARN => trade proceeds with
//     the confidence penalty still applied (never a full-confidence trade).
//   - Missing `regime` config block => DEFAULT_REGIME_CONFIG (documented table).
//     The gate never fail-opens simply because the operator has not activated a
//     v3-regime config yet.
//   - Unknown price feed => UNKNOWN => fail-closed VETO for altcoins (SAFE-001).
//
// Pure: no network, no D1, no clock except what caller supplies.

const isAltcoin = (symbol) => !/^BTCUSDT$/i.test(String(symbol ?? ""));

// DEFAULT_REGIME_CONFIG — the veto table the gate uses when the active
// strategy_configs row carries no `regime` block (or only part of one).
//
// WHY A DEFAULT AT ALL: a watch may opt in (`regime_filter=1`) while the
// operator has not activated a v3-regime config yet. Resolving the missing
// block to "no veto lists" would make the gate fail OPEN — it would report a
// hostile regime and still let the trade through. The defaults are the
// documented docs/08 table, so opting in is never a no-op and an UNKNOWN feed
// (the fail-closed case, SAFE-001) still vetoes altcoins.
export const DEFAULT_REGIME_CONFIG = Object.freeze({
  enabled: true,
  veto_altcoin_long: Object.freeze(["BEARISH", "UNKNOWN"]),
  veto_altcoin_short: Object.freeze(["BULLISH", "UNKNOWN"]),
  veto_btc_long: Object.freeze(["UNKNOWN"]),
  veto_btc_short: Object.freeze(["UNKNOWN"]),
  action_on_veto: "BLOCK",
  confidence_penalty: 0.3,
});

/** resolveRegimeConfig — merge the operator's block over the defaults.
 *  A partial block (`{regime: {enabled: true}}`) keeps the veto table instead of
 *  silently emptying it, and a non-object block is treated as absent. */
export function resolveRegimeConfig(config) {
  const block = config && typeof config === "object" && config.regime && typeof config.regime === "object"
    ? config.regime
    : {};
  const merged = { ...DEFAULT_REGIME_CONFIG, ...block };
  // Lists are config, so a caller may pass [] to deliberately disable one edge;
  // anything that is not an array falls back to the documented default.
  for (const key of ["veto_altcoin_long", "veto_altcoin_short", "veto_btc_long", "veto_btc_short"]) {
    if (!Array.isArray(merged[key])) merged[key] = [...DEFAULT_REGIME_CONFIG[key]];
    else merged[key] = merged[key].filter((v) => typeof v === "string");
  }
  const action = String(merged.action_on_veto ?? "BLOCK").toUpperCase();
  merged.action_on_veto = action === "WARN" ? "WARN" : "BLOCK";
  const p = Number(merged.confidence_penalty);
  merged.confidence_penalty = Number.isFinite(p) && p >= 0 && p <= 1
    ? p
    : DEFAULT_REGIME_CONFIG.confidence_penalty;
  merged.enabled = merged.enabled !== false;
  return merged;
}

// ---- EMA helper (closes are decimal strings) ----
const ema = (closes, period) => {
  if (!closes || closes.length === 0) return null;
  const k = 2 / (period + 1);
  let prev = Number(closes[0]);
  if (!Number.isFinite(prev)) return null;
  for (let i = 1; i < closes.length; i++) {
    const c = Number(closes[i]);
    if (!Number.isFinite(c)) continue;
    prev = c * k + prev * (1 - k);
  }
  return prev;
};

// classify one index vs its own EMA-50 close history.
// closes: oldest-first decimal strings. last close is current price.
const classifyIndex = (closes) => {
  if (!closes || closes.length < 2) return "UNKNOWN";
  const last = closes[closes.length - 1];
  const trend = ema(closes.slice(0, -1), 50); // EMA over history BEFORE current bar
  if (trend === null) return "UNKNOWN";
  const c = Number(last);
  if (!Number.isFinite(c)) return "UNKNOWN";
  return c > trend ? "BULLISH" : c < trend ? "BEARISH" : "CHOP";
};

// count regimes among available indices (skip UNKNOWN for the majority vote).
const majorityRegime = (trends) => {
  let bull = 0, bear = 0, n = 0;
  for (const t of Object.values(trends)) {
    if (t === "BULLISH") { bull++; n++; }
    else if (t === "BEARISH") { bear++; n++; }
  }
  if (n === 0) return "UNKNOWN";
  if (bull > bear && bull > n / 2) return "BULLISH";
  if (bear > bull && bear > n / 2) return "BEARISH";
  return "CHOP";
};

const vetoList = (cfg, key) => {
  const v = cfg?.[key];
  return Array.isArray(v) ? v : [];
};

const inList = (list, value) => Array.isArray(list) && list.includes(value);

// evaluateRegime — the pure decision.
export function evaluateRegime(input) {
  const { symbol, direction, prices = {}, config = {} } = input ?? {};
  const regimeCfg = resolveRegimeConfig(config);
  const enabled = regimeCfg.enabled;

  if (!enabled) {
    return {
      regime: "UNKNOWN", verdict: "PASS",
      reason: "regime filter disabled for this watch",
      confidence_penalty: 0,
      detail: { index_trend: {}, vetoed_by: null, action_on_veto: regimeCfg.action_on_veto },
      force_flat: false,
    };
  }

  const indexTrend = {};
  const feeds = ["ETHBTC", "USDT.D", "BTC.D", "TOTAL3"];
  for (const f of feeds) {
    const closes = prices[f];
    indexTrend[f] = classifyIndex(Array.isArray(closes) ? closes : null);
  }

  const regime = majorityRegime(indexTrend);
  // Optional provenance: the feed may say which provider answered each index
  // (exchange klines vs a CoinGecko estimate). It is carried into the run so an
  // operator can tell a measured series from an estimated one.
  const sources = prices && typeof prices === "object" && prices.sources && typeof prices.sources === "object"
    ? prices.sources
    : null;

  // Veto table (first match wins).
  let vetoedBy = null;
  if (isAltcoin(symbol)) {
    if (direction === "LONG" &&
      inList(vetoList(regimeCfg, "veto_altcoin_long"), regime)) vetoedBy = `altcoin LONG vs regime ${regime}`;
    else if (direction === "SHORT" &&
      inList(vetoList(regimeCfg, "veto_altcoin_short"), regime)) vetoedBy = `altcoin SHORT vs regime ${regime}`;
  } else {
    if (direction === "LONG" &&
      inList(vetoList(regimeCfg, "veto_btc_long"), regime)) vetoedBy = `BTC LONG vs regime ${regime}`;
    else if (direction === "SHORT" &&
      inList(vetoList(regimeCfg, "veto_btc_short"), regime)) vetoedBy = `BTC SHORT vs regime ${regime}`;
  }

  const action = regimeCfg.action_on_veto;
  const normPenalty = regimeCfg.confidence_penalty;

  let verdict, reason;
  if (vetoedBy) {
    verdict = "VETO";
    reason = `regime veto: ${vetoedBy}`;
  } else if (regime === "CHOP" || regime === "UNKNOWN") {
    verdict = "WARN";
    reason = regime === "UNKNOWN"
      ? "regime UNKNOWN: reference index feed missing — proceeding with reduced confidence"
      : `regime CHOP: no clear directional bias — proceeding with reduced confidence`;
  } else {
    verdict = "PASS";
    reason = `regime ${regime} aligned with ${direction} on ${symbol}`;
  }

  // BLOCK is the fail-closed action; WARN is the operator's explicit opt-out of
  // force-flat, and it must still cost confidence — otherwise `action_on_veto:
  // "WARN"` would turn a veto into a full-confidence trade.
  const forceFlat = verdict === "VETO" && action === "BLOCK";
  const penalized = forceFlat ? 0 : (verdict === "VETO" || verdict === "WARN") ? normPenalty : 0;

  return {
    regime,
    verdict,
    reason: penalized > 0
      ? `${reason} (confidence −${Math.round(penalized * 100)}%)`
      : reason,
    confidence_penalty: penalized,
    detail: { index_trend: indexTrend, vetoed_by: vetoedBy, action_on_veto: action, sources },
    // downstream consumers can force FLAT on VETO/BLOCK
    force_flat: forceFlat,
  };
}
