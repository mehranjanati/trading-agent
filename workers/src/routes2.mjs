// routes2.mjs — E05-T01-S2: signal / analysis / approval routes.
import { ok, err } from "./errors.mjs";
import { signalBody, approvalBody, intentBody } from "./validate.mjs";
import { validateSignal, SCHEMA_VERSION } from "./signals.mjs";
import { uid, roleOf, guard, readBody, writeErr, recordIncident } from "./_shared.mjs";
import { activeVersion, activateVersion, verifyWebhook, allowlistFor, sourceAllowed } from "./strategies.mjs";
import { decideApproval as decideApprovalRecord, ttlMsFrom } from "./approvals.mjs";
import { limitsFrom } from "./risk.mjs";
import { submitIntent as runSubmit } from "./execution.mjs";
import { engageKill, releaseKill, readKill } from "./kill.mjs";
import { createPaperExchange } from "./exchange.mjs";
import { readLease } from "./health-route.mjs";

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
      if (b.engaged) return ok(await engageKill(env, { actor, reason: b.reason ?? "unspecified" }), 201);
      if (actor !== "admin") return err("FORBIDDEN", "kill release requires admin", {});
      return ok(await releaseKill(env, { actor, reason: b.reason ?? "unspecified", confirm: b.confirm === true }), 200);
    }),
    runAnalysis: safe(async (req, env) => {
      const b = await readBody(req);
      if (!b.watch_id) { const e = new Error("watch_id required"); e.code = "VALIDATION"; throw e; }
      const now = new Date().toISOString();
      const id = uid("an");
      // E07-T01-S2a: pin the version that is active AT RUN START — old runs
      // keep their pin forever (pin-immutability is what E09 will audit).
      const active = await activeVersion(env);
      const pinned = active?.version ?? null;
      const out = { bias: "FLAT", confidence: 0.4, reasons: ["E05 stub: model wiring in E07"], model: "stub", input_hash: "na", strategy_version: pinned };
      await env.DB.prepare(
        "INSERT INTO analysis_runs(id,watch_id,model,input_hash,output_json,confidence,at) VALUES(?,?,?,?,?,?,?)",
      ).bind(id, b.watch_id, out.model, out.input_hash, JSON.stringify(out), out.confidence, now).run();
      return ok({ id, ...out }, 201);
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
      return ok(out, 201);
    }),
  };
}
