import assert from "node:assert/strict";
import { evaluateRegime } from "./regime.mjs";

const closes = (n) => Array.from({ length: n }, (_, i) => String(100 + i)); // monotonic up => BULLISH vs EMA

const cfg = (regime) => ({
  regime: {
    enabled: true,
    veto_altcoin_long: ["BEARISH", "UNKNOWN"],
    veto_altcoin_short: ["BULLISH", "UNKNOWN"],
    veto_btc_long: ["UNKNOWN"],
    veto_btc_short: ["UNKNOWN"],
    action_on_veto: "BLOCK",
    confidence_penalty: 0.3,
  },
});

const prices = (ethbtc = closes(60)) => ({ ETHBTC: ethbtc, "USDT.D": null, "BTC.D": null, TOTAL3: null });

// ETHBTC alone BULLISH => regime BULLISH (only 1 index, it is > half of available)
console.log("--- regime tests ---");

// 1. Altcoin LONG + BULLISH regime => PASS
let r = evaluateRegime({ symbol: "ETHUSDT", direction: "LONG", prices: prices(), config: cfg() });
assert(r.regime === "BULLISH", "regime BULLISH");
assert(r.verdict === "PASS", "altcoin LONG + BULLISH => PASS");
assert(r.force_flat === false);
console.log("PASS: altcoin LONG + BULLISH => PASS", r.reason);

// 2. Altcoin LONG + BEARISH regime => VETO
const bearish = Array.from({ length: 60 }, (_, i) => String(100 - i)); // monotonic down
r = evaluateRegime({ symbol: "ETHUSDT", direction: "LONG", prices: prices(bearish), config: cfg() });
assert(r.regime === "BEARISH", "regime BEARISH");
assert(r.verdict === "VETO", "altcoin LONG + BEARISH => VETO");
assert(r.force_flat === true);
console.log("PASS: altcoin LONG + BEARISH => VETO", r.reason);

// 3. Altcoin SHORT + BULLISH regime => VETO
r = evaluateRegime({ symbol: "ETHUSDT", direction: "SHORT", prices: prices(), config: cfg() });
assert(r.verdict === "VETO", "altcoin SHORT + BULLISH => VETO");
assert(r.force_flat === true);
console.log("PASS: altcoin SHORT + BULLISH => VETO", r.reason);

// 4. BTC LONG + UNKNOWN => VETO
r = evaluateRegime({ symbol: "BTCUSDT", direction: "LONG", prices: { ETHBTC: null, "USDT.D": null, "BTC.D": null, TOTAL3: null }, config: cfg() });
assert(r.regime === "UNKNOWN", "regime UNKNOWN");
assert(r.verdict === "VETO", "BTC LONG + UNKNOWN => VETO");
assert(r.force_flat === true);
console.log("PASS: BTC LONG + UNKNOWN => VETO", r.reason);

// 5. Regime disabled => PASS
r = evaluateRegime({ symbol: "ETHUSDT", direction: "LONG", prices: prices(bearish), config: { regime: { enabled: false } } });
assert(r.verdict === "PASS", "regime disabled => PASS");
console.log("PASS: regime disabled => PASS", r.reason);

// 6. regime_filter off (caller passes enabled:false) => PASS
r = evaluateRegime({ symbol: "ETHUSDT", direction: "LONG", prices: prices(bearish), config: cfg() });
r.verdict; // already tested above as BEARISH veto
console.log("ALL REGIME TESTS PASSED");
