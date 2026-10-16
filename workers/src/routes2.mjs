// routes2.mjs — E05-T01-S2: signal / analysis / approval routes.
import { ok, err } from "./errors.mjs";
import { signalBody, approvalBody, intentBody } from "./validate.mjs";
import { validateSignal, SCHEMA_VERSION } from "./signals.mjs";
import { uid, roleOf, guard, readBody, writeErr, recordIncident, sha256Hex } from "./_shared.mjs";
import { activeVersion, activateVersion, verifyWebhook, allowlistFor, sourceAllowed, listVersions } from "./strategies.mjs";
import { decideApproval as decideApprovalRecord, listApprovals, ttlMsFrom } from "./approvals.mjs";
import { limitsFrom } from "./risk.mjs";
import { submitIntent as runSubmit } from "./execution.mjs";
import { engageKill, releaseKill, readKill } from "./kill.mjs";
import { createPaperExchange } from "./exchange.mjs";
import { readLease } from "./health-route.mjs";
import { watcherBase } from "./proxy.mjs";

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
    /** POST /api/analysis:runs — the advisory analysis run for one watch.
     *
     *  E14-T03: a run is produced by the LIVE engine or not at all. The handler
     *  resolves the watch from D1, reads the pinned catalog from the Go plane
     *  (GET /strategies/registry — the bytes the runner will execute), posts the
     *  analysis, and persists the engine's OWN aggregate + per-verdict
     *  provenance. There is deliberately NO local fallback: an analysis row is
     *  what a human approves against, so an invented row would be mock data in
     *  the canonical DB. Engine unreachable → 503 DEGRADED and nothing written. */
    runAnalysis: safe(async (req, env) => {
      const g = guard("POST /api/analysis:runs", req);
      if (g) return g;
      const b = await readBody(req);
      if (typeof b.watch_id !== "string" || !b.watch_id) {
        const e = new Error("watch_id required"); e.code = "VALIDATION"; throw e;
      }
      const w = (await env.DB.prepare(
        "SELECT id,symbol,direction,status FROM watches WHERE id=?",
      ).bind(b.watch_id).all()).results?.[0];
      if (!w) return err("NOT_FOUND", `watch ${b.watch_id} not found`, {});
      const base = watcherBase(env);

      // The strategy set comes from the registry, never a list repeated here: a
      // version that appears in it is one the runner can actually execute.
      let pins;
      try {
        const regRes = await fetch(`${base}/strategies/registry`);
        if (!regRes.ok) throw new Error(`registry HTTP ${regRes.status}`);
        pins = (((await regRes.json()).strategies) ?? [])
          .slice(0, 8) // /analyze caps the set at 8
          .map((s) => ({ id: s.id, version: s.version, config: {} }));
        if (!pins.length) throw new Error("registry has no pinned strategy");
      } catch (e) {
        return err("DEGRADED", `analysis engine unavailable (${e.message}) — no run written`, { retryable: true });
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
        return err("DEGRADED", `analysis engine unavailable (${e.message}) — no run written`, { retryable: true });
      }
      const agg = engine?.aggregate ?? {};
      if (typeof agg.bias !== "string") {
        return err("DEGRADED", "analysis engine returned no aggregate — no run written", { retryable: true });
      }

      // E07-T01-S2a: pin the version that is active AT RUN START — old runs
      // keep their pin forever (pin-immutability is what E09 will audit).
      const active = await activeVersion(env);
      const verdicts = engine.verdicts ?? [];
      const out = {
        bias: agg.bias,
        confidence: agg.confidence,
        reasons: [agg.explanation ?? ""],
        model: "wasm-engine",
        // The digest of the exact request the engine answered, so the row can be
        // re-run and compared instead of taken on faith.
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
      const now = new Date().toISOString();
      const id = uid("an");
      await env.DB.prepare(
        "INSERT INTO analysis_runs(id,watch_id,model,input_hash,output_json,confidence,at) VALUES(?,?,?,?,?,?,?)",
      ).bind(id, b.watch_id, out.model, out.input_hash, JSON.stringify(out), out.confidence ?? null, now).run();
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
    /** GET /api/positions — current position snapshots (from fills only). */
    listPositions: safe(async (_req, env) => {
      const rows = await env.DB.prepare(
        "SELECT symbol, size, entry_px, leverage, updated_at FROM positions ORDER BY symbol",
      ).all().catch(() => ({ results: [] }));
      return ok({ positions: rows.results ?? [] });
    }),
  };
}
