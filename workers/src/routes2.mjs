// routes2.mjs — E05-T01-S2: signal / analysis / approval routes.
import { ok } from "./errors.mjs";
import { signalBody, approvalBody } from "./validate.mjs";
import { uid, roleOf, guard, readBody, writeErr } from "./_shared.mjs";

export function miscRoutes() {
  const safe = (fn) => async (req, env) => {
    try { return await fn(req, env); } catch (e) { return writeErr(e); }
  };
  return {
    ingestSignal: safe(async (req, env) => {
      const g = guard("POST /api/signals:ingest", req);
      if (g) return g;
      const b = await readBody(req);
      signalBody(b);
      const now = new Date().toISOString();
      const id = uid("sig");
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO signals(id,watch_id,kind,payload_json,source,at) VALUES(?,?,?,?,?,?)",
        ).bind(id, b.watch_id ?? null, b.kind, JSON.stringify(b.payload), b.source, now),
        env.DB.prepare(
          "INSERT INTO events(id,type,entity_id,payload_json,dedupe_key,at) VALUES(?,?,?,?,?,?)",
        ).bind(uid("evt"), "signal.ingested_v1", b.watch_id ?? id, JSON.stringify({ kind: b.kind }), `signal.ingested_v1:${id}:0`, now),
      ]);
      return ok({ id }, 201);
    }),
    runAnalysis: safe(async (req, env) => {
      const b = await readBody(req);
      if (!b.watch_id) { const e = new Error("watch_id required"); e.code = "VALIDATION"; throw e; }
      const now = new Date().toISOString();
      const id = uid("an");
      const out = { bias: "FLAT", confidence: 0.4, reasons: ["E05 stub: model wiring in E07"], model: "stub", input_hash: "na" };
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
      const now = new Date().toISOString();
      const id = uid("ap");
      const exp = new Date(Date.now() + 600_000).toISOString();
      await env.DB.prepare(
        "INSERT INTO approvals(id,watch_id,analysis_id,decision,reason,approver,single_use,expires_at,at) VALUES(?,?,?,?,?,?,1,?,?)",
      ).bind(id, b.watch_id, b.analysis_id, b.decision, b.reason ?? null, roleOf(req), exp, now).run();
      return ok({ id, decision: b.decision, expires_at: exp }, 201);
    }),
  };
}
