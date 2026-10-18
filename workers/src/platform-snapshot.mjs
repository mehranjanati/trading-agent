// platform-snapshot.mjs — per-turn platform context for the advisory chat plane.
//
// The chat model has no platform access of its own: in every turn it must be
// TOLD the state of the system it advises on (mode, watches, signals,
// approvals, intents, positions, recent incidents) — the same discipline as
// the prices package (ADR-004): unknown data is labelled unavailable, NEVER
// interpolated, and every line carries its age so the model cannot quote a
// stale number as live.
//
// Budget: counts + the newest ≤5 rows per domain, compact one-line rows.
// Reading is fail-soft: a missing table/env.DB yields an explicit
// "unavailable" line, never a throw — chat is advisory, so a snapshot outage
// degrades the answer, not the service.
//
// The snapshot is EPHEMERAL: the caller prepends it as a system message that
// is NOT stored (mirrors the Go market-context injection in chat/server.go),
// so a later turn never quotes yesterday's injected state as history.

/** Max rows per domain — keeps the assembled turn inside the 24K budget. */
export const SNAPSHOT_LIMIT = 5;

/** Advisory guard: the model must never believe it can act (D-08). */
export const ADVISORY_GUARD =
  "You are an ADVISORY-ONLY assistant: you cannot place, cancel or approve orders, " +
  "touch watches/approvals/leases/kill-switch state, or execute anything. " +
  "Answer with analysis and proposals; the human decides and acts.";

/** Answering rule for catalog questions: the rows ARE the database read for
 *  this turn, so a blanket "I have no database access" is never a valid reply
 *  while a strategy/draft/registry row is present. */
export const SNAPSHOT_RULES =
  "The rows above are a LIVE read of the platform database for this turn. " +
  "When asked for the strategies in the database / the strategy list, list the " +
  "strategy, draft and registry rows above (or say that domain is empty); do not " +
  "claim you lack database access while those rows are present.";

/** One guarded query: missing table/env.DB -> [], never a throw. */
async function rows(env, sqlText, ...args) {
  try {
    if (!env?.DB?.prepare) return [];
    const r = await env.DB.prepare(sqlText).bind(...args).all();
    return r.results ?? [];
  } catch {
    return [];
  }
}

/** Age of an ISO timestamp in whole seconds (null when unparsable). */
export function ageSec(at, nowMs = Date.now()) {
  const t = Date.parse(at ?? "");
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((nowMs - t) / 1000));
}

/** "3m ago" / "2h ago" / "n/a" — compact age labels for the snapshot lines. */
export function ageLabel(at, nowMs = Date.now()) {
  const s = ageSec(at, nowMs);
  if (s === null) return "n/a";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

/** Collect the raw snapshot (counts + newest rows) from D1. */
export async function collectSnapshot(env, { limit = SNAPSHOT_LIMIT } = {}) {
  const [modeRows, watchCounts, watches, signals, approvals, intents, orders, positions, incidents, versions, drafts, registry] = await Promise.all([
    rows(env, "SELECT status, at, detail_json FROM health_snapshots WHERE component='mode' ORDER BY at DESC, rowid DESC LIMIT 1"),
    rows(env, "SELECT status, COUNT(*) AS n FROM watches GROUP BY status"),
    rows(env, "SELECT id, symbol, direction, status, updated_at FROM watches ORDER BY updated_at DESC LIMIT ?", limit),
    rows(env, "SELECT kind, watch_id, source, at FROM signals ORDER BY at DESC LIMIT ?", limit),
    rows(env, "SELECT id, watch_id, decision, approver, used_at, expires_at, at FROM approvals ORDER BY at DESC LIMIT ?", limit),
    rows(env, "SELECT id, watch_id, side, qty, status, at FROM order_intents ORDER BY at DESC LIMIT ?", limit),
    rows(env, "SELECT client_order_id, exchange_order_id, status, fills_json, last_reconciled_at, at FROM orders ORDER BY at DESC LIMIT ?", limit),
    rows(env, "SELECT symbol, size, entry_px, leverage, updated_at FROM positions ORDER BY symbol"),
    rows(env, "SELECT incident, action, actor, at FROM recovery_log ORDER BY at DESC LIMIT ?", limit),
    rows(env, "SELECT version, config_json, activated_by, at FROM strategy_configs ORDER BY at DESC LIMIT ?", limit),
    rows(env, "SELECT id, strategy_id, version, status, created_at FROM strategy_drafts WHERE status <> 'deleted' ORDER BY created_at DESC LIMIT ?", limit),
    registryRows(env, limit),
  ]);
  return { modeRows, watchCounts, watches, signals, approvals, intents, orders, positions, incidents, versions, drafts, registry };
}

/** Number of fills in a fills_json blob (0 when absent/malformed). */
export function fillCount(raw) {
  try {
    const fills = JSON.parse(raw ?? "[]");
    return Array.isArray(fills) ? fills.length : 0;
  } catch {
    return 0;
  }
}

/** Compact config one-liner (one line, bounded — same discipline as ages). */
function configText(raw, max = 120) {
  const one = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!one) return "{}";
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

// The pinned catalog is static for minutes at a time and lives on the Go plane;
// cache it per isolate so chat turns do not pay a cross-service hop each time.
let registryCache = { at: 0, rows: [] };
const REGISTRY_TTL_MS = 60_000;

/** Newest pinned registry rows, [] when the Go plane is unwired/unreachable.
 *  Never throws: a catalog outage degrades the answer, not the turn. */
async function registryRows(env, limit) {
  if (!env?.GO_WATCHER_URL) return []; // unwired in tests/local — skip the hop
  if (Date.now() - registryCache.at < REGISTRY_TTL_MS) return registryCache.rows.slice(0, limit);
  try {
    const { watcherBase } = await import("./proxy.mjs");
    const res = await fetch(`${watcherBase(env)}/strategies/registry`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return [];
    const body = await res.json();
    const rows = Array.isArray(body?.strategies) ? body.strategies : [];
    registryCache = { at: Date.now(), rows };
    return rows.slice(0, limit);
  } catch {
    return [];
  }
}

/** Render the collected snapshot as compact system-message text. */
export function renderSnapshot(s, { nowMs = Date.now() } = {}) {
  const L = [];
  L.push("PLATFORM SNAPSHOT (read-only, advisory context — ages are relative to this turn):");
  const mode = s.modeRows?.[0];
  if (mode) {
    let reasons = "";
    try {
      const d = JSON.parse(mode.detail_json ?? "{}");
      if (Array.isArray(d.reasons) && d.reasons.length) reasons = ` reasons=[${d.reasons.slice(0, 3).join("; ")}]`;
    } catch { /* detail is best-effort */ }
    L.push(`mode: ${mode.status} (${ageLabel(mode.at, nowMs)})${reasons}`);
  } else {
    L.push("mode: unavailable (no health snapshot yet)");
  }
  if (s.watchCounts?.length) {
    L.push(`watches: ${s.watchCounts.map((r) => `${r.status}=${r.n}`).join(" ")}`);
  } else {
    L.push("watches: none");
  }
  if (s.versions?.length) {
    for (const v of s.versions) L.push(`strategy: ${v.version} by=${v.activated_by ?? "?"} config=${configText(v.config_json)} (${ageLabel(v.at, nowMs)})`);
  }
  if (s.drafts?.length) {
    for (const d of s.drafts) L.push(`draft: ${d.id} ${d.strategy_id}@${d.version} ${d.status} (${ageLabel(d.created_at, nowMs)})`);
  }
  if (s.registry?.length) {
    for (const r of s.registry) L.push(`registry: ${r.id}@${r.version} ${r.status}`);
  }
  if (s.watches?.length) for (const w of s.watches) L.push(`watch: ${w.symbol} ${w.direction} ${w.status} (${ageLabel(w.updated_at, nowMs)})`);
  if (s.signals?.length) for (const g of s.signals) L.push(`signal: ${g.kind} watch=${String(g.watch_id ?? "?").slice(0, 12)} src=${g.source} (${ageLabel(g.at, nowMs)})`);
  const pending = (s.approvals ?? []).filter((a) => a.decision === "approve" && !a.used_at);
  L.push(`approvals: ${s.approvals?.length ?? 0} recent, ${pending.length} pending grant(s)`);
  for (const a of pending.slice(0, SNAPSHOT_LIMIT)) L.push(`pending: ${a.id} watch=${String(a.watch_id ?? "?").slice(0, 12)} by=${a.approver} (${ageLabel(a.at, nowMs)})`);
  const open = (s.intents ?? []).filter((i) => !["FILLED", "CANCELLED", "REJECTED"].includes(String(i.status)));
  L.push(`intents: ${s.intents?.length ?? 0} recent, ${open.length} open`);
  for (const i of open.slice(0, SNAPSHOT_LIMIT)) L.push(`open-intent: ${i.side} ${i.qty} ${i.status} (${ageLabel(i.at, nowMs)})`);
  if (s.orders?.length) {
    for (const o of s.orders) L.push(`order: ${o.client_order_id} ${o.status} fills=${fillCount(o.fills_json)} (${ageLabel(o.at, nowMs)})`);
  }
  if (s.positions?.length) {
    for (const p of s.positions) L.push(`position: ${p.symbol} size=${p.size} entry=${p.entry_px ?? "?"} lev=${p.leverage ?? "?"} (${ageLabel(p.updated_at, nowMs)})`);
  } else {
    L.push("positions: none (fills only — paper-sim fills are simulated, D-06)");
  }
  if (s.incidents?.length) for (const r of s.incidents) L.push(`incident: ${r.incident} action=${r.action} (${ageLabel(r.at, nowMs)})`);
  L.push(SNAPSHOT_RULES);
  L.push(ADVISORY_GUARD);
  return L.join("\n");
}

/** One call: collect + render. Never throws (fail-soft by design). */
export async function platformSnapshot(env, opts = {}) {
  try {
    return renderSnapshot(await collectSnapshot(env, opts), opts);
  } catch {
    return `PLATFORM SNAPSHOT: unavailable (snapshot read failed)\n${ADVISORY_GUARD}`;
  }
}

