// routes2.mjs — E05-T01-S2: signal / analysis / approval routes.
import { ok, err } from "./errors.mjs";
import { signalBody, approvalBody, intentBody } from "./validate.mjs";
import { validateSignal, SCHEMA_VERSION } from "./signals.mjs";
import { uid, roleOf, guard, readBody, writeErr, recordIncident, sha256Hex } from "./_shared.mjs";
import { enqueueAlert } from "./notify.mjs";
import { activeVersion, activateVersion, verifyWebhook, allowlistFor, sourceAllowed, listVersions } from "./strategies.mjs";
import { decideApproval as decideApprovalRecord, readApproval, listApprovals, ttlMsFrom } from "./approvals.mjs";
import { limitsFrom } from "./risk.mjs";
import { submitIntent as runSubmit } from "./execution.mjs";
import { engageKill, releaseKill, readKill } from "./kill.mjs";
import { createPaperExchange } from "./exchange.mjs";
import { readLease } from "./health-route.mjs";
import { watcherBase } from "./proxy.mjs";
import { transitionStatements } from "./watches.mjs";

// D-06: Toobit has no testnet, so the wired venue is the paper simulator. Tests
// and drills inject `env.EXCHANGE` to drive ack-loss / partial-fill scenarios;
// the signed-REST client swaps in behind the same interface.
const defaultExchange = createPaperExchange({ fill: true });

/** Contract validation + version tagging. Shared by the webhook path so there is
 *  exactly one place that decides whether a payload is admissible. */
function validatePayload(b) {
  signalBody(b);
  // E07-T01-S1: strict per-kind contract (exact $.path on violation) and the
  // registry version is stamped into the row, so a run pinned later knows
  // exactly which contract admitted the signal it reads.
  const { schema_version } = validateSignal(b.kind, b.payload);
  return { schema_version, tagged: { ...b.payload, _schema_version: schema_version } };
}

async function persistSignal(env, b, { schema_version, tagged }) {
  const now = new Date().toISOString();
  const id = uid("sig");
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO signals(id,watch_id,kind,payload_json,source,at) VALUES(?,?,?,?,?,?)",
    ).bind(id, b.watch_id ?? null, b.kind, JSON.stringify(tagged), b.source, now),
    env.DB.prepare(
      "INSERT INTO events(id,type,entity_id,payload_json,dedupe_key,at) VALUES(?,?,?,?,?,?)",
    ).bind(uid("evt"), "signal.ingested_v1", b.watch_id ?? id, JSON.stringify({ kind: b.kind, schema_version: SCHEMA_VERSION }), `signal.ingested_v1:${id}:0`, now),
  ]);
  return ok({ id, schema_version }, 201);
}

/** readWatch — the fields every analysis/trigger decision needs. */
async function readWatch(env, id) {
  const rows = (await env.DB.prepare(
    "SELECT id,symbol,direction,status,version FROM watches WHERE id=?",
  ).bind(id).all()).results ?? [];
  return rows[0] ?? null;
}

/** degraded — an engine/plane problem that must NOT become fabricated data. */
function degraded(message) {
  const e = new Error(message);
  e.code = "DEGRADED";
  return e;
}

/** analyzeWatch — the advisory run for one watch, computed by the LIVE engine.
 *
 *  E14-T03: reads the pinned catalog from the Go plane (GET /strategies/registry
 *  — the bytes the runner will execute), posts /analyze with the watch's
 *  symbol+direction, and persists the engine's OWN aggregate + per-verdict
 *  provider provenance + the digest of the exact request. There is deliberately
 *  NO local fallback: an analysis row is what a human approves against, so an
 *  invented row would be mock data in the canonical DB. Every failure path
 *  throws DEGRADED and writes nothing.
 *
 *  @returns {Promise<{id: string, out: object}>} */
async function analyzeWatch(env, w) {
  const base = watcherBase(env);
  let pins;
  try {
    const regRes = await fetch(`${base}/strategies/registry`);
    if (!regRes.ok) throw new Error(`registry HTTP ${regRes.status}`);
    const catalog = ((await regRes.json()).strategies) ?? [];
    // ADR-011: a RETIRED version stays executable for references already in
    // flight, but a NEW run must never pin one. The registry serves the full
    // catalog with each entry's status, so the filter lives here, at the only
    // place that builds a new pin set. An entry without a status is active
    // (older registry), and if everything is retired this is a DEGRADED run —
    // never a run pinned to a withdrawn artifact.
    const active = catalog.filter((s) => s.status !== "retired");
    pins = active
      .slice(0, 8) // /analyze caps the set at 8
      .map((s) => ({ id: s.id, version: s.version, config: {} }));
    if (!pins.length) {
      throw new Error(catalog.length
        ? `registry has no ACTIVE pinned strategy (${catalog.length} retired)`
        : "registry has no pinned strategy");
    }
  } catch (e) {
    throw degraded(`analysis engine unavailable (${e.message})`);
  }

  const ask = { symbol: w.symbol, direction: w.direction, strategies: pins };
  let engine;
  try {
    const res = await fetch(`${base}/analyze`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ask),
    });
    if (!res.ok) throw new Error(`analyze HTTP ${res.status}`);
    engine = await res.json();
  } catch (e) {
    throw degraded(`analysis engine unavailable (${e.message})`);
  }
  const agg = engine?.aggregate ?? {};
  if (typeof agg.bias !== "string") throw degraded("analysis engine returned no aggregate");

  // E07-T01-S2a: pin the version active AT RUN START — old runs keep their pin.
  const active = await activeVersion(env);
  const verdicts = engine.verdicts ?? [];
  const out = {
    bias: agg.bias,
    confidence: agg.confidence,
    reasons: [agg.explanation ?? ""],
    model: "wasm-engine",
    input_hash: await sha256Hex(JSON.stringify(ask)),
    strategy_version: active?.version ?? null,
    engine: {
      analyze_id: engine.id ?? null,
      at: engine.at ?? null,
      symbol: engine.symbol ?? w.symbol,
      strategies: pins.map((p) => `${p.id}@${p.version}`),
      // Which provider answered per timeframe — the same provenance the
      // dashboard shows on the setup card.
      data_sources: [...new Set(verdicts.map((v) => v.data_source).filter(Boolean))],
      aggregate: { agree: agg.agree, disagree: agg.disagree, flat: agg.flat, errors: agg.errors, n: agg.n },
      verdicts: verdicts.map((v) => ({
        strategy_id: v.strategy_id, strategy_version: v.strategy_version, timeframe: v.timeframe,
        data_source: v.data_source, status: v.result?.status,
        bias: v.result?.decision?.bias, confidence: v.result?.decision?.confidence,
        reason: v.result?.diagnostics?.reason,
      })),
      suggest_zones: engine.suggest_zones ?? null,
    },
  };
  const id = uid("an");
  await env.DB.prepare(
    "INSERT INTO analysis_runs(id,watch_id,model,input_hash,output_json,confidence,at) VALUES(?,?,?,?,?,?,?)",
  ).bind(id, w.id, out.model, out.input_hash, JSON.stringify(out), out.confidence ?? null, new Date().toISOString()).run();
  return { id, out };
}

export function miscRoutes() {
  const safe = (fn) => async (req, env) => {
    try { return await fn(req, env); } catch (e) { return writeErr(e); }
  };
  return {
    /** E07-T01-S2b: the authenticated signal webhook (FR-005 "signed payload").
     *  Order is deliberate: authenticate → validate contract → authorise source
     *  → store. A bad payload is 400 whatever the source; an unlisted-but-signed
     *  source is 403. Provenance proves identity only — see strategies.mjs. */
    ingestSignalWebhook: safe(async (req, env) => {
      const rawBody = await req.text();
      let b;
      try { b = JSON.parse(rawBody); } catch { const e = new Error("invalid JSON"); e.code = "VALIDATION"; throw e; }
      let source;
      try {
        ({ source } = await verifyWebhook(env, req.headers, rawBody));
      } catch (e) {
        await recordIncident(env, "signal.auth_rejected", `reason=${e?.reason ?? e?.message}`, "signal-webhook");
        const out = new Error("invalid webhook signature");
        out.code = "AUTH";
        throw out;
      }
      // The verified header identity supersedes any body claim, and satisfies the
      // source requirement of the shared body contract.
      const merged = { ...b, source };
      const validated = validatePayload(merged); // 400 (with $.path) before any provenance decision
      const active = await activeVersion(env);
      const cfg = allowlistFor(active ? JSON.parse(active.config_json) : {});
      if (!sourceAllowed(cfg, b.kind, source)) {
        await recordIncident(env, "signal.provenance_rejected", `source=${source} kind=${b.kind}`, "signal-webhook");
        const e = new Error(`source ${source} not allowlisted for ${b.kind}`);
        e.code = "FORBIDDEN";
        throw e;
      }
      // The stored row's source is the VERIFIED identity, never the body's claim.
      return persistSignal(env, merged, validated);
    }),
    activateStrategy: safe(async (req, env) => {
      const g = guard("POST /api/strategy:activate", req);
      if (g) return g;
      const b = await readBody(req);
      if (!b.version || typeof b.version !== "string") { const e = new Error("version required"); e.code = "VALIDATION"; throw e; }
      return ok(await activateVersion(env, { version: b.version, config: b.config, actor: roleOf(req) }), 201);
    }),
    /** E09-T01: the ONE order path (D-08). Kill → fence → risk → consume →
     *  intent → submit. The client supplies only {approval_id, side, qty,
     *  leverage}: identity (client_order_id) is derived here and the price comes
     *  from our own market data, never from the caller. */
    submitIntent: safe(async (req, env) => {
      const g = guard("POST /api/orders:intents", req);
      if (g) return g;
      const b = await readBody(req);
      intentBody(b);
      const active = await activeVersion(env);
      // A config that cannot supply every bound throws DEGRADED (fail closed).
      const limits = limitsFrom(active ? JSON.parse(active.config_json) : null, active?.version);
      const out = await runSubmit(env, {
        approval_id: b.approval_id, side: b.side, qty: b.qty, leverage: b.leverage,
        exchange: env.EXCHANGE ?? defaultExchange,
        lease: await readLease(env).catch(() => null),
        kill: await (async () => { try { return await readKill(env); } catch { return { engaged: "unknown", read_error: true }; } })(),
        limits, limits_version: active?.version ?? null,
        actor: roleOf(req),
      });
      if (!out.ok) {
        return err(out.code, out.reason ?? "rejected", {
          extra: out.risk_code ? { risk_code: out.risk_code, detail: out.detail ?? null } : {},
        });
      }
      // Alert (best-effort): order submitted — outcome reconciles to terminal.
      try {
        const ap = await readApproval(env, b.approval_id).catch(() => null);
        const wr = ap ? await readWatch(env, ap.watch_id).catch(() => null) : null;
        await enqueueAlert(env, {
          topic: "ORDER_UPDATE", symbol: wr?.symbol ?? null,
          payload: { direction: wr?.direction ?? null, extra: { status: out.order_status ?? out.status ?? "SUBMITTED", qty: b.qty, note: `intent ${out.intent_id}` } },
          dedupeKey: `ORDER_UPDATE:${out.intent_id}`,
        });
      } catch { /* advisory only */ }
      return ok(out, out.status);
    }),
    /** E09-T01: kill switch (SAFE-006). Engage is operator+; release needs admin
     *  AND an explicit confirm (two-person rule). The flag is persisted, so a
     *  restart cannot silently clear a halt. */
    killSwitch: safe(async (req, env) => {
      const g = guard("POST /api/kill-switch", req);
      if (g) return g;
      const b = await readBody(req);
      if (typeof b.engaged !== "boolean") { const e = new Error("engaged boolean required"); e.code = "VALIDATION"; throw e; }
      const actor = roleOf(req);
      if (b.engaged) {
        const out = await engageKill(env, { actor, reason: b.reason ?? "unspecified" });
        try {
          await enqueueAlert(env, {
            topic: "SAFETY", symbol: null,
            payload: { extra: { title: "کیل‌سوییچ فعال شد", detail: `توسط ${actor} — دلیل: ${b.reason ?? "unspecified"}` } },
            dedupeKey: `SAFETY:kill:${Date.now()}`,
          });
        } catch { /* advisory only */ }
        return ok(out, 201);
      }
      if (actor !== "admin") return err("FORBIDDEN", "kill release requires admin", {});
      return ok(await releaseKill(env, { actor, reason: b.reason ?? "unspecified", confirm: b.confirm === true }), 200);
    }),
    /** POST /api/analysis:runs — the advisory analysis run for one watch.
     *
     *  E14-T03: a run is produced by the LIVE engine or not at all (see
     *  analyzeWatch). This handler resolves the watch from D1 (a run is about a
     *  real watch) and answers 503 DEGRADED — writing nothing — when the engine
     *  cannot be reached. */
    runAnalysis: safe(async (req, env) => {
      const g = guard("POST /api/analysis:runs", req);
      if (g) return g;
      const b = await readBody(req);
      if (typeof b.watch_id !== "string" || !b.watch_id) {
        const e = new Error("watch_id required"); e.code = "VALIDATION"; throw e;
      }
      const w = await readWatch(env, b.watch_id);
      if (!w) return err("NOT_FOUND", `watch ${b.watch_id} not found`, {});
      try {
        const { id, out } = await analyzeWatch(env, w);
        return ok({ id, ...out }, 201);
      } catch (e) {
        if (e.code === "DEGRADED") return err("DEGRADED", `${e.message} — no run written`, { retryable: true });
        throw e;
      }
    }),
    /** POST /api/watches:trigger — the trigger loop's edge into D1 (E03-T01).
     *
     *  The Go plane evaluates ACTIVE watches against live ticks and posts the edge
     *  it decided; this route owns the transaction (Go never writes D1):
     *  FSM-guarded transition + event (dedupe_key = type:watch_id:seq, UNIQUE) +
     *  outbox, then for a TRIGGERED watch the advisory analysis run and the
     *  TRIGGERED→ANALYZED edge. If the engine is unreachable the watch stays
     *  TRIGGERED and NOTHING is fabricated — the run can be re-asked explicitly.
     *
     *  Auth: the go-agent token (x-agent-token, same shared secret as the
     *  heartbeat) — the loop is a service, not a browser. A replay or a stale
     *  evaluation is answered 200 with an explicit `duplicate`/`ignored` reason,
     *  never an error: the loop must be able to retry safely. */
    triggerWatch: safe(async (req, env) => {
      const want = env.GO_AGENT_TOKEN ?? env.GO_HEARTBEAT_TOKEN;
      if (want && req.headers.get("x-agent-token") !== want) {
        return err("AUTH", "bad agent token", {});
      }
      const b = await readBody(req);
      const kind = b.kind === "TRIGGERED" ? "TRIGGERED" : b.kind === "INVALIDATED" ? "INVALIDATED" : null;
      if (!kind) { const e = new Error("kind must be TRIGGERED|INVALIDATED"); e.code = "VALIDATION"; throw e; }
      if (typeof b.watch_id !== "string" || !b.watch_id) {
        const e = new Error("watch_id required"); e.code = "VALIDATION"; throw e;
      }
      if (typeof b.px !== "string" || !/^\d+(\.\d+)?$/.test(b.px)) {
        const e = new Error("px must be a decimal string (money is never a float)"); e.code = "VALIDATION"; throw e;
      }
      if (!Number.isInteger(b.seq) || b.seq < 1) {
        const e = new Error("seq must be an integer >= 1 (it is the dedupe identity)"); e.code = "VALIDATION"; throw e;
      }
      const at = typeof b.ts === "string" && b.ts ? b.ts : new Date().toISOString();
      const w = await readWatch(env, b.watch_id);
      if (!w) return err("NOT_FOUND", `watch ${b.watch_id} not found`, {});

      const evtType = kind === "TRIGGERED" ? "watch.triggered_v1" : "watch.invalidated_v1";
      const dedupe = `${evtType}:${w.id}:${b.seq}`;
      const seen = (await env.DB.prepare(
        "SELECT id FROM events WHERE dedupe_key=?",
      ).bind(dedupe).all().catch(() => ({ results: [] }))).results ?? [];
      if (seen.length) return ok({ watch_id: w.id, status: w.status, duplicate: true, dedupe_key: dedupe }, 200);
      if (w.status !== "ACTIVE") {
        return ok({ watch_id: w.id, status: w.status, ignored: `not ACTIVE (${w.status})` }, 200);
      }
      if (Number.isInteger(b.watch_version) && b.watch_version !== w.version) {
        return ok({ watch_id: w.id, status: w.status, ignored: `stale evaluation (v${b.watch_version} != v${w.version})` }, 200);
      }

      const now = new Date().toISOString();
      const batch = [
        ...transitionStatements(env, {
          id: w.id, from: "ACTIVE", to: kind, expectedVersion: w.version,
          tid: uid("tr"), reason: `${kind === "TRIGGERED" ? "trigger" : "invalidation"} hit @ ${b.px}`,
          actor: "go-watcher", at: now,
        }),
        env.DB.prepare(
          "INSERT INTO events(id,type,entity_id,payload_json,dedupe_key,at) VALUES(?,?,?,?,?,?)",
        ).bind(uid("evt"), evtType, w.id, JSON.stringify({ symbol: w.symbol, px: b.px, prev_px: b.prev_px ?? null, seq: b.seq }), dedupe, at),
        env.DB.prepare(
          "INSERT INTO outbox(id,aggregate,payload_json,attempts,done) VALUES(?,?,?,0,0)",
        ).bind(uid("obx"), "watches", JSON.stringify({ watch_id: w.id, edge: kind })),
      ];
      try {
        await env.DB.batch(batch);
      } catch (e) {
        // The UNIQUE dedupe_key is the backstop for a race with the SELECT above.
        if (/UNIQUE/i.test(String(e.message))) {
          return ok({ watch_id: w.id, status: w.status, duplicate: true, dedupe_key: dedupe }, 200);
        }
        throw e;
      }

      if (kind === "INVALIDATED") {
        // Alert (best-effort, never fatal): the trade path already committed.
        try {
          await enqueueAlert(env, {
            topic: "INVALIDATED", symbol: w.symbol,
            payload: { direction: w.direction, px: b.px },
            dedupeKey: `INVALIDATED:${dedupe}`,
          });
        } catch { /* alerting is advisory — trade flow unaffected */ }
        return ok({ watch_id: w.id, status: "INVALIDATED", seq: b.seq }, 200);
      }

      // TRIGGERED → ANALYZED: the advisory run. The re-read is deliberate — if
      // anything moved the watch while the engine worked, we do NOT record an
      // edge that did not happen.
      let run;
      try {
        run = await analyzeWatch(env, w);
      } catch (e) {
        return ok({ watch_id: w.id, status: "TRIGGERED", seq: b.seq, analysis_degraded: e.message }, 202);
      }
      // Alert: trigger fired (best-effort — trade flow already committed).
      try {
        await enqueueAlert(env, {
          topic: "TRIGGERED", symbol: w.symbol,
          payload: { direction: w.direction, px: b.px },
          dedupeKey: `TRIGGERED:${dedupe}`,
        });
      } catch { /* advisory only */ }
      // Alert: analysis ready with the WASM verdict.
      try {
        await enqueueAlert(env, {
          topic: "ANALYSIS_READY", symbol: w.symbol,
          payload: { direction: w.direction, extra: { bias: run.out.bias, confidence: run.out.confidence } },
          dedupeKey: `ANALYSIS_READY:${run.id}`,
        });
      } catch { /* advisory only */ }
      const cur = await readWatch(env, w.id);
      if (cur?.status === "TRIGGERED" && cur.version === w.version + 1) {
        await env.DB.batch(transitionStatements(env, {
          id: w.id, from: "TRIGGERED", to: "ANALYZED", expectedVersion: cur.version,
          tid: uid("tr"), reason: `analysis ${run.id} stored`, actor: "go-watcher", at: new Date().toISOString(),
        }));
        return ok({
          watch_id: w.id, status: "ANALYZED", seq: b.seq, analysis_id: run.id,
          bias: run.out.bias, confidence: run.out.confidence, model: run.out.model, engine: run.out.engine,
        }, 201);
      }
      return ok({
        watch_id: w.id, status: cur?.status ?? "TRIGGERED", seq: b.seq, analysis_id: run.id,
        note: "watch moved while the analysis ran — no ANALYZED edge recorded",
      }, 200);
    }),
    decideApproval: safe(async (req, env) => {
      const g = guard("POST /api/approvals", req);
      if (g) return g;
      const b = await readBody(req);
      approvalBody(b);
      // TTL from the ACTIVE strategy version (E07 pinning); 10m default (Q-05).
      const active = await activeVersion(env);
      const ttlMs = ttlMsFrom(active ? JSON.parse(active.config_json) : null);
      const out = await decideApprovalRecord(env, {
        id: uid("ap"), watch_id: b.watch_id, analysis_id: b.analysis_id,
        decision: b.decision, reason: b.reason, approver: roleOf(req), ttlMs,
      });
      // Alert (best-effort): grant/reject decided by the human.
      try {
        const wr = await readWatch(env, b.watch_id).catch(() => null);
        if (b.decision === "approve") {
          await enqueueAlert(env, {
            topic: "APPROVAL_REQUESTED", symbol: wr?.symbol ?? null,
            payload: { direction: wr?.direction ?? null, extra: { summary: `تأیید شد توسط ${roleOf(req)} — آماده ثبت سفارش`, expires_in: "10 دقیقه" } },
            dedupeKey: `APPROVAL_GRANTED:${out.id ?? b.watch_id}`,
          });
        }
      } catch { /* advisory only */ }
      return ok(out, 201);
    }),
    /** GET /api/strategy — list all strategy versions (dashboard strategy page). */
    listStrategy: safe(async (_req, env) => {
      return ok(await listVersions(env));
    }),
    /** GET /api/approvals — list recent approvals (dashboard approvals page). */
    listApprovals: safe(async (_req, env) => {
      return ok(await listApprovals(env));
    }),
    /** GET /api/signals — recent ingested signals (newest first, bounded). */
    listSignals: safe(async (_req, env) => {
      const rows = await env.DB.prepare(
        "SELECT id, watch_id, kind, payload_json, source, at FROM signals ORDER BY at DESC LIMIT 100",
      ).all().catch(() => ({ results: [] }));
      return ok({ signals: rows.results ?? [] });
    }),
    /** GET /api/analysis — recent analysis runs (newest first, bounded). */
    listAnalysis: safe(async (_req, env) => {
      const rows = await env.DB.prepare(
        "SELECT id, watch_id, model, input_hash, output_json, confidence, at FROM analysis_runs ORDER BY at DESC LIMIT 100",
      ).all().catch(() => ({ results: [] }));
      return ok({ runs: rows.results ?? [] });
    }),
    /** GET /api/orders:intents — recent order intents (newest first, bounded). */
    listIntents: safe(async (_req, env) => {
      const rows = await env.DB.prepare(
        "SELECT id, watch_id, approval_id, side, qty, leverage, client_order_id, status, at FROM order_intents ORDER BY at DESC LIMIT 100",
      ).all().catch(() => ({ results: [] }));
      return ok({ intents: rows.results ?? [] });
    }),
    /** GET /api/orders — exchange-side order state + fills (reconciled).
     *  Distinct from order_intents: that is the REQUEST, this is what the
     *  venue acknowledged. The chat operator snapshot reads it (docs/18).
     *  `?summary=1` returns fills_count instead of the fills_json blob: the
     *  chat only needs the count, and blobs can blow the server's 1 MB read. */
    listOrders: safe(async (req, env) => {
      const summary = new URL(req.url).searchParams.get("summary") === "1";
      const cols = summary
        ? "client_order_id, exchange_order_id, status, CASE WHEN json_valid(fills_json) THEN json_array_length(fills_json) ELSE 0 END AS fills_count, last_reconciled_at, at"
        : "client_order_id, exchange_order_id, status, fills_json, last_reconciled_at, at";
      const rows = await env.DB.prepare(
        `SELECT ${cols} FROM orders ORDER BY at DESC LIMIT 100`,
      ).all().catch(() => ({ results: [] }));
      return ok({ orders: rows.results ?? [] });
    }),
    /** GET /api/positions — current position snapshots (from fills only). */
    listPositions: safe(async (_req, env) => {
      const rows = await env.DB.prepare(
        "SELECT symbol, size, entry_px, leverage, updated_at FROM positions ORDER BY symbol",
      ).all().catch(() => ({ results: [] }));
      return ok({ positions: rows.results ?? [] });
    }),
    /** GET /api/notify:prefs — which alert topics push to Telegram (absent = on). */
    listNotifyPrefs: safe(async (_req, env) => {
      const { TOPICS } = await import("./notify.mjs");
      const rows = await env.DB.prepare(
        "SELECT topic, enabled FROM notify_prefs",
      ).all().catch(() => ({ results: [] }));
      const saved = Object.fromEntries((rows.results ?? []).map((r) => [r.topic, Number(r.enabled) !== 0]));
      return ok({ prefs: TOPICS.map((t) => ({ topic: t, enabled: saved[t] ?? true })) });
    }),
    /** POST /api/notify:prefs — toggle alert topics (trader+; advisory only). */
    setNotifyPrefs: safe(async (req, env) => {
      const g = guard("POST /api/notify:prefs", req);
      if (g) return g;
      const { TOPICS, isTopic } = await import("./notify.mjs");
      const b = await readBody(req);
      const prefs = b.prefs;
      if (!prefs || typeof prefs !== "object" || Array.isArray(prefs)) {
        const e = new Error("prefs object required {TOPIC: boolean}");
        e.code = "VALIDATION";
        throw e;
      }
      const now = new Date().toISOString();
      const updated = [];
      for (const [topic, enabled] of Object.entries(prefs)) {
        if (!isTopic(topic)) {
          const e = new Error(`unknown topic ${topic} (one of ${TOPICS.join(",")})`);
          e.code = "VALIDATION";
          throw e;
        }
        await env.DB.prepare(
          "INSERT INTO notify_prefs(topic,enabled,updated_at) VALUES(?,?,?) " +
            "ON CONFLICT(topic) DO UPDATE SET enabled=excluded.enabled, updated_at=excluded.updated_at",
        ).bind(topic, enabled ? 1 : 0, now).run();
        updated.push({ topic, enabled: !!enabled });
      }
      return ok({ updated });
    }),
  };
}
