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
//   - WARN (not a veto): regime CHOP or regime opposite-but-not-vetoed =>
//     confidence is reduced by confidence_penalty, trade still allowed.
//   - action_on_veto = BLOCK => bias forced FLAT. WARN => trade proceeds.
//   - Unknown price feed => UNKNOWN => fail-closed VETO for altcoins (SAFE-001).
//
// Pure: no network, no D1, no clock except what caller supplies.

const TREND_RE = /^(BULLISH|BEARISH|CHOP|UNKNOWN)$/;
const VERDICT_RE = /^(PASS|VETO|WARN)$/;
const REGIME_RE = /^(BULLISH|BEARISH|CHOP|UNKNOWN)$/;

const isAltcoin = (symbol) => !/^BTCUSDT$/i.test(String(symbol ?? ""));

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
  const regimeCfg = config.regime ?? {};
  const enabled = regimeCfg.enabled !== false;

  if (!enabled) {
    return {
      regime: "UNKNOWN", verdict: "PASS",
      reason: "regime filter disabled for this watch",
      confidence_penalty: 0,
      detail: { index_trend: {}, vetoed_by: null },
    };
  }

  const indexTrend = {};
  const feeds = ["ETHBTC", "USDT.D", "BTC.D", "TOTAL3"];
  for (const f of feeds) {
    const closes = prices[f];
    indexTrend[f] = classifyIndex(Array.isArray(closes) ? closes : null);
  }

  const regime = majorityRegime(indexTrend);

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

  const action = regimeCfg.action_on_veto ?? "BLOCK";
  const penalty = Number(regimeCfg.confidence_penalty ?? 0.3);
  const normPenalty = Number.isFinite(penalty) && penalty >= 0 && penalty <= 1 ? penalty : 0.3;

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

  return {
    regime,
    verdict,
    reason,
    confidence_penalty: verdict === "WARN" ? normPenalty : 0,
    detail: { index_trend: indexTrend, vetoed_by: vetoedBy },
    // downstream consumers can force FLAT on VETO/BLOCK
    force_flat: verdict === "VETO" && action === "BLOCK",
  };
}
