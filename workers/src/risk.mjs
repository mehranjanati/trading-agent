// risk.mjs — E08-T01: deterministic risk gates (docs/08 §8.2). Pure, no network.
//
// `validate(intent, ctx) -> PASS | REJECT(code, detail)`. The eight codes are
// user-visible and evaluated in a FIXED order; the first failure wins, so a
// reject is reproducible. AI output can never reach this function (SAFE-003) —
// it takes limits and evidence, nothing else.
//
// Fail closed (SAFE-001): a missing/unknown input is a REJECT, never a PASS.
// Money is exact decimal strings, never floats — notional is computed with
// BigInt scaled arithmetic so 0.1*0.3 never drifts into a false pass.
export const RISK_CODES = ["R-KILL", "R-APPROVAL", "R-SYM", "R-LEV", "R-NOT", "R-EXP", "R-STALE", "R-DUP"];

const DEC_RE = /^\d+(\.\d+)?$/;
const isDec = (v) => typeof v === "string" && DEC_RE.test(v);

// ---- exact decimal helpers (strings in, strings out; no Number arithmetic) ----
const scaleOf = (s) => (s.split(".")[1]?.length ?? 0);
const unscaled = (s) => { const [i, f = ""] = s.split("."); return BigInt(i + f); };
function fromUnscaled(v, scale) {
  const neg = v < 0n; if (neg) v = -v;
  const digits = v.toString();
  if (scale === 0) return (neg ? "-" : "") + digits;
  const padded = digits.padStart(scale + 1, "0");
  return (neg ? "-" : "") + padded.slice(0, -scale) + "." + padded.slice(-scale);
}
function align(a, b) {
  const sa = scaleOf(a), sb = scaleOf(b), s = Math.max(sa, sb);
  return [unscaled(a) * 10n ** BigInt(s - sa), unscaled(b) * 10n ** BigInt(s - sb), s];
}
export function cmpDec(a, b) { const [x, y] = align(a, b); return x < y ? -1 : x > y ? 1 : 0; }
export function addDec(a, b) { const [x, y, s] = align(a, b); return fromUnscaled(x + y, s); }
export function mulDec(a, b) { return fromUnscaled(unscaled(a) * unscaled(b), scaleOf(a) + scaleOf(b)); }
// normalize a decimal string (trim leading zeros / trailing fraction zeros)
export function normDec(s) { const [i, f = ""] = s.split("."); const fi = f.replace(/0+$/, ""); return fi ? `${BigInt(i)}.${fi}` : `${BigInt(i)}`; }
/** Exact division, truncated (never rounded up — a position is never overstated).
 *  `scale` bounds the fraction digits. Division by zero throws: callers must
 *  treat that as a system fault, not a zero. */
export function divDec(a, b, scale = 8) {
  const [x, y] = align(a, b);
  if (y === 0n) { const e = new Error("decimal division by zero"); e.code = "DEGRADED"; throw e; }
  return fromUnscaled((x * 10n ** BigInt(scale)) / y, scale);
}

const reject = (code, reason, detail = {}) => ({ ok: false, code, reason, detail, risk_code: code });
const pass = (limits_version) => ({ ok: true, code: "PASS", limits_version });

/** validate — the eight gates in fixed order, first failure wins.
 *
 *  ctx shape (all evidence supplied by the caller, so this stays pure):
 *    { now_ms, limits, limits_version,
 *      kill:     { engaged, actor?, reason? },
 *      approval: { decision, used_at, expires_at, watch_id } | null,
 *      watch:    { id, symbol, direction } | null,
 *      price:    { px, at_ms, symbol } | null,
 *      exposure: { open_notional_usd } | null,
 *      live_intent_for_approval: boolean }
 */
export function validate(intent, ctx = {}) {
  const L = ctx.limits;
  if (!L) { const e = new Error("risk limits not supplied"); e.code = "DEGRADED"; throw e; }
  const v = ctx.limits_version;
  const nowMs = ctx.now_ms ?? Date.now();

  // R-KILL — kill switch must be provably off (unknown == engaged, SAFE-001/006)
  if (!ctx.kill || ctx.kill.engaged !== false) {
    return reject("R-KILL", "kill switch engaged or unknown", {
      engaged: ctx.kill?.engaged ?? null, actor: ctx.kill?.actor ?? null, reason: ctx.kill?.reason ?? null,
    });
  }

  // R-APPROVAL — valid + granted + unused + unexpired (SAFE-002)
  const a = ctx.approval;
  if (!a) return reject("R-APPROVAL", "no approval for intent", { approval_id: intent.approval_id ?? null });
  if (a.decision !== "approve") return reject("R-APPROVAL", "approval not granted", { decision: a.decision ?? null });
  if (a.used_at) return reject("R-APPROVAL", "approval already consumed", { used_at: a.used_at });
  const expMs = Date.parse(a.expires_at ?? "");
  if (!Number.isFinite(expMs)) return reject("R-APPROVAL", "approval expiry unreadable", { expires_at: a.expires_at ?? null });
  if (nowMs >= expMs) return reject("R-APPROVAL", "approval expired", { expires_at: a.expires_at, now_ms: nowMs });

  // R-SYM — symbol allowlist; reject carries the permitted set ("reject + suggest")
  const symbol = ctx.watch?.symbol ?? null;
  if (!symbol) return reject("R-SYM", "symbol unknown", { symbol: null, allowlist: L.allowlist });
  if (!L.allowlist.includes(symbol)) {
    return reject("R-SYM", `symbol ${symbol} not allowlisted`, { symbol, allowlist: L.allowlist, suggest: L.allowlist });
  }

  // R-LEV — leverage <= max (reject carries limit + asked, J3)
  if (!Number.isInteger(intent.leverage) || intent.leverage < 1) {
    return reject("R-LEV", "leverage invalid", { limit: L.max_leverage, asked: intent.leverage ?? null });
  }
  if (intent.leverage > L.max_leverage) {
    return reject("R-LEV", `leverage ${intent.leverage} exceeds max ${L.max_leverage}`, { limit: L.max_leverage, asked: intent.leverage });
  }

  // R-NOT / R-EXP need a price to size the intent; no price == cannot prove -> R-STALE later.
  const px = ctx.price?.px;
  if (!isDec(px ?? "") || !isDec(intent.qty ?? "")) return reject("R-NOT", "notional not computable (bad qty/price)", { qty: intent.qty ?? null, px: px ?? null });
  const notional = mulDec(intent.qty, px);

  // R-NOT — per-intent notional <= cap
  if (cmpDec(notional, L.max_notional_usd) > 0) {
    return reject("R-NOT", `notional ${normDec(notional)} exceeds max ${normDec(L.max_notional_usd)}`, { limit: L.max_notional_usd, asked: normDec(notional) });
  }

  // R-EXP — open exposure + this intent <= cap (unknown exposure fails closed)
  const open = ctx.exposure?.open_notional_usd;
  if (!isDec(open ?? "")) return reject("R-EXP", "open exposure unknown", { open: open ?? null, limit: L.max_exposure_usd });
  const total = addDec(open, notional);
  if (cmpDec(total, L.max_exposure_usd) > 0) {
    return reject("R-EXP", `exposure ${normDec(total)} exceeds cap ${normDec(L.max_exposure_usd)}`, { limit: L.max_exposure_usd, open: normDec(open), asked: normDec(total) });
  }

  // R-STALE — price age <= threshold (missing price/at == stale, SAFE-001)
  const atMs = ctx.price?.at_ms;
  if (!Number.isFinite(atMs)) return reject("R-STALE", "price freshness unknown", { at_ms: atMs ?? null, threshold_s: L.stale_s_seconds });
  const ageMs = nowMs - atMs;
  if (ageMs > L.stale_s_seconds * 1000) {
    return reject("R-STALE", `price age ${Math.round(ageMs / 1000)}s exceeds ${L.stale_s_seconds}s`, { age_ms: ageMs, threshold_s: L.stale_s_seconds, action: "HOLD" });
  }

  // R-DUP — no live intent for the same approval (unknown fails closed)
  if (ctx.live_intent_for_approval !== false) {
    return reject("R-DUP", "live intent exists for approval (or unknown)", { approval_id: intent.approval_id ?? null, live: ctx.live_intent_for_approval ?? null });
  }

  return pass(v);
}

/** limitsFrom — normalise the limits of the ACTIVE `strategy_configs` version
 *  (E07-T01 pinning), so a reject is auditable against the exact version that
 *  judged it. A config that cannot supply every bound is a system fault, not a
 *  gate failure: throw `DEGRADED` (fail closed) rather than guessing a default
 *  (SAFE-003). */
export function limitsFrom(config, version) {
  const c = config ?? {};
  const need = (k) => {
    const v = c[k];
    if (v === undefined || v === null) { const e = new Error(`risk limits missing ${k} (version ${version ?? "?"})`); e.code = "DEGRADED"; throw e; }
    return v;
  };
  const limits = {
    max_leverage: need("max_leverage"),
    max_notional_usd: need("max_notional_usd"),
    max_exposure_usd: need("max_exposure_usd"),
    allowlist: need("allowlist"),
    stale_s_seconds: need("stale_s_seconds"),
  };
  if (!Number.isInteger(limits.max_leverage) || limits.max_leverage < 1) { const e = new Error("max_leverage must be a positive integer"); e.code = "DEGRADED"; throw e; }
  if (!isDec(limits.max_notional_usd) || !isDec(limits.max_exposure_usd)) { const e = new Error("notional/exposure limits must be decimal strings"); e.code = "DEGRADED"; throw e; }
  if (!Array.isArray(limits.allowlist)) { const e = new Error("allowlist must be an array"); e.code = "DEGRADED"; throw e; }
  if (!Number.isFinite(limits.stale_s_seconds) || limits.stale_s_seconds < 0) { const e = new Error("stale_s_seconds must be >= 0"); e.code = "DEGRADED"; throw e; }
  return limits;
}
