// signals.mjs — E07-T01-S1: signal schema registry v1 + pure per-kind validators.
//
// The registry maps the five ingest kinds to their JSON contracts in
// `schemas/signals/`. Validation is hand-rolled (no vendored validator — the
// Workers plane is stdlib-only, same rule as `validate.mjs`) so every failure
// carries an exact JSON path (`$.legs[2].price`), which is what the S1
// acceptance asserts on. `validateSignal(kind, payload)` returns
// `{ ok, schema_version }` or throws `{ code: "VALIDATION", path }`.
// Money is decimal strings, never floats — same rule as the rest of E05.
export const SCHEMA_VERSION = "1";

const SYM_RE = /^[A-Z]{2,12}USDT$/;
const DEC_RE = /^\d+(\.\d+)?$/;

function fail(path, why) {
  const e = new Error(`${path}: ${why}`);
  e.code = "VALIDATION";
  e.path = path;
  throw e;
}
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function needSym(p, v, path) {
  if (typeof v !== "string" || !SYM_RE.test(v)) fail(path, "must match ^[A-Z]{2,12}USDT$");
}
function needDecStr(p, v, path) {
  if (typeof v !== "string" || !DEC_RE.test(v)) fail(path, "must be decimal string");
}
function needEnum(p, v, path, values) {
  if (!values.includes(v)) fail(path, `must be one of [${values.join(",")}]`);
}
function needNum(p, v, path, lo, hi) {
  if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) fail(path, `must be number ${lo}..${hi}`);
}
function strictKeys(p, path, allowed) {
  for (const k of Object.keys(p)) {
    if (!allowed.includes(k)) fail(`${path}.${k}`, "unknown field");
  }
}

function divergenceTriple(p, path = "$") {
  if (!isObj(p)) fail(path, "must be object");
  for (const k of ["symbol", "direction", "legs", "at"]) {
    if (!(k in p)) fail(`${path}.${k}`, "required");
  }
  needSym(p, p.symbol, `${path}.symbol`);
  needEnum(p, p.direction, `${path}.direction`, ["LONG", "SHORT"]);
  if (!Array.isArray(p.legs) || p.legs.length !== 3) fail(`${path}.legs`, "must be exactly 3 legs");
  p.legs.forEach((leg, i) => {
    const lp = `${path}.legs[${i}]`;
    if (!isObj(leg)) fail(lp, "must be object");
    if (typeof leg.anchor !== "string" || !leg.anchor) fail(`${lp}.anchor`, "required non-empty");
    needDecStr(p, leg.price, `${lp}.price`);
    strictKeys(leg, lp, ["anchor", "price"]);
  });
  if (typeof p.at !== "string" || !p.at) fail(`${path}.at`, "required non-empty");
  strictKeys(p, path, ["symbol", "direction", "legs", "at"]);
  return true;
}

function orderBlock(p, path = "$") {
  if (!isObj(p)) fail(path, "must be object");
  for (const k of ["symbol", "side", "zone_low", "zone_high"]) {
    if (!(k in p)) fail(`${path}.${k}`, "required");
  }
  needSym(p, p.symbol, `${path}.symbol`);
  needEnum(p, p.side, `${path}.side`, ["BUY", "SELL"]);
  needDecStr(p, p.zone_low, `${path}.zone_low`);
  needDecStr(p, p.zone_high, `${path}.zone_high`);
  if ("mitigated" in p && typeof p.mitigated !== "boolean") fail(`${path}.mitigated`, "must be boolean");
  strictKeys(p, path, ["symbol", "side", "zone_low", "zone_high", "mitigated"]);
  return true;
}

function obOs(p, path = "$") {
  if (!isObj(p)) fail(path, "must be object");
  for (const k of ["symbol", "metric", "value", "threshold"]) {
    if (!(k in p)) fail(`${path}.${k}`, "required");
  }
  needSym(p, p.symbol, `${path}.symbol`);
  needEnum(p, p.metric, `${path}.metric`, ["RSI_14", "STOCH_14", "MFI_14"]);
  needNum(p, p.value, `${path}.value`, 0, 100);
  needNum(p, p.threshold, `${path}.threshold`, 0, 100);
  if ("timeframe" in p && (typeof p.timeframe !== "string" || !p.timeframe)) fail(`${path}.timeframe`, "must be non-empty string");
  strictKeys(p, path, ["symbol", "metric", "value", "threshold", "timeframe"]);
  return true;
}

function mtf(p, path = "$") {
  if (!isObj(p)) fail(path, "must be object");
  for (const k of ["symbol", "timeframes", "agreement"]) {
    if (!(k in p)) fail(`${path}.${k}`, "required");
  }
  needSym(p, p.symbol, `${path}.symbol`);
  if (!Array.isArray(p.timeframes) || p.timeframes.length < 2 || p.timeframes.length > 4) {
    fail(`${path}.timeframes`, "must have 2..4 entries");
  }
  p.timeframes.forEach((t, i) => {
    const tp = `${path}.timeframes[${i}]`;
    if (!isObj(t)) fail(tp, "must be object");
    if (typeof t.tf !== "string" || !t.tf) fail(`${tp}.tf`, "required non-empty");
    needEnum(p, t.bias, `${tp}.bias`, ["LONG", "SHORT", "FLAT"]);
    strictKeys(t, tp, ["tf", "bias"]);
  });
  needEnum(p, p.agreement, `${path}.agreement`, ["LONG", "SHORT", "MIXED"]);
  strictKeys(p, path, ["symbol", "timeframes", "agreement"]);
  return true;
}

function regime(p, path = "$") {
  if (!isObj(p)) fail(path, "must be object");
  for (const k of ["symbol", "regime"]) {
    if (!(k in p)) fail(`${path}.${k}`, "required");
  }
  needSym(p, p.symbol, `${path}.symbol`);
  needEnum(p, p.regime, `${path}.regime`, ["TREND", "RANGE", "BREAKOUT", "CHOP"]);
  if ("confidence" in p) needNum(p, p.confidence, `${path}.confidence`, 0, 1);
  if ("volatility_band" in p && (typeof p.volatility_band !== "string" || !p.volatility_band)) {
    fail(`${path}.volatility_band`, "must be non-empty string");
  }
  strictKeys(p, path, ["symbol", "regime", "confidence", "volatility_band"]);
  return true;
}

export const KIND_VALIDATORS = {
  DIVERGENCE_TRIPLE: divergenceTriple,
  ORDER_BLOCK: orderBlock,
  OB_OS: obOs,
  MTF: mtf,
  REGIME: regime,
};

/** Validate one signal payload. Unknown kind or shape violation throws
 *  `{ code: "VALIDATION", path }`; success records the registry version so the
 *  row knows which contract admitted it. */
export function validateSignal(kind, payload) {
  const fn = KIND_VALIDATORS[kind];
  if (!fn) {
    const e = new Error(`unknown signal kind ${kind}`);
    e.code = "VALIDATION";
    e.path = "$.kind";
    throw e;
  }
  fn(payload, "$");
  return { ok: true, schema_version: SCHEMA_VERSION };
}
