// routes.mjs — E05-T01-S1: watch routes (D1 batch: row + event + outbox).
import { err, ok } from "./errors.mjs";
import { watchBody } from "./validate.mjs";
import { uid, roleOf, guard, readBody, writeErr } from "./_shared.mjs";
import { transitionStatements } from "./watches.mjs";

export function watchRoutes(store) {
  const safe = (fn) => async (req, env) => {
    try { return await fn(req, env); } catch (e) { return writeErr(e); }
  };
  return {
    list: safe(async (req, env) => {
      const u = new URL(req.url);
      const status = u.searchParams.get("status");
      const rows = status
        ? await env.DB.prepare("SELECT * FROM watches WHERE status=? ORDER BY updated_at DESC").bind(status).all()
        : await env.DB.prepare("SELECT * FROM watches ORDER BY updated_at DESC LIMIT 100").all();
      return ok({ watches: rows.results ?? [] });
    }),
    snapshot: safe(async (req, env) => {
      const now = new Date().toISOString();
      const r = await env.DB.prepare(
        "SELECT id,symbol,direction,trigger_json,invalidation_json,status,version,expires_at FROM watches WHERE status='ACTIVE' ORDER BY symbol,id",
      ).all();
      return ok({ watches: r.results ?? [], at: now });
    }),
    create: safe(async (req, env) => {
      const g = guard("POST /api/watches", req);
      if (g) return g;
      const b = await readBody(req);
      watchBody(b);
      const now = new Date().toISOString();
      const idem = req.headers.get("Idempotency-Key") ?? "";
      const prior = await store.lookup("POST /api/watches", idem);
      if (prior) return ok(prior.body, prior.status);
      const id = uid("w");
      const actor = roleOf(req);
      // The watch is born DRAFT and PUBLISHED in the same batch (docs/05 §5.3:
      // DRAFT→ACTIVE "publish"). Why in one request: the only write the dashboard
      // performs is this one — the Stalk click IS the human publish — and a watch
      // left DRAFT is evaluated by nothing (the Go trigger loop and the fallback
      // poller read status='ACTIVE' only), so the zone would silently never arm.
      // Arming is advisory: a trigger still leads to analysis, and every order
      // needs its own single-use human approval (SAFE-002, D-08).
      const batch = [
        env.DB.prepare(
          "INSERT INTO watches(id,symbol,direction,trigger_json,invalidation_json,status,version,created_by,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,'DRAFT',1,?,?,?,?)",
        ).bind(id, b.symbol, b.direction, JSON.stringify(b.trigger), JSON.stringify(b.invalidation ?? {}), actor, b.expires_at ?? null, now, now),
        ...transitionStatements(env, {
          id, from: "DRAFT", to: "ACTIVE", expectedVersion: 1,
          tid: uid("tr"), reason: "publish (stalk)", actor, at: now,
        }),
        env.DB.prepare(
          "INSERT INTO events(id,type,entity_id,payload_json,dedupe_key,at) VALUES(?,?,?,?,?,?)",
        ).bind(uid("evt"), "watch.created_v1", id, JSON.stringify({ symbol: b.symbol }), `watch.created_v1:${id}:0`, now),
        env.DB.prepare(
          "INSERT INTO events(id,type,entity_id,payload_json,dedupe_key,at) VALUES(?,?,?,?,?,?)",
        ).bind(uid("evt"), "watch.activated_v1", id, JSON.stringify({ symbol: b.symbol, direction: b.direction, trigger: b.trigger }), `watch.activated_v1:${id}:1`, now),
        env.DB.prepare(
          "INSERT INTO outbox(id,aggregate,payload_json,attempts,done) VALUES(?,?,?,0,0)",
        ).bind(uid("obx"), "watches", JSON.stringify({ watch_id: id })),
      ];
      await env.DB.batch(batch);
      // version 2: the row was created at 1 and the publish edge bumped it.
      const res = { id, version: 2, status: "ACTIVE" };
      await store.save("POST /api/watches", idem, 201, res);
      return ok(res, 201);
    }),
  };
}
