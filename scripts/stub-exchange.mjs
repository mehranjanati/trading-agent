// stub-exchange.mjs — E06-T02-S3c: local Toobit stand-in for the no-429 proof.
//
// Weight accounting mirrors the verified facts (docs/ops/TOOBIT-API-FACTS.md, A-02):
// REQUEST_WEIGHT 3000/min, the price endpoint costs 1 weight per symbol, and a breach
// answers 429 + X-Api-Limit-Reset-Timestamp with the documented -1003 body.
//
// TEST DOUBLE ONLY — never imported by production code. `now` is injectable so the
// drills can run five simulated minutes of polling in milliseconds and stay
// deterministic.
import http from "node:http";

export const DEFAULT_WINDOW_MS = 60_000;

export function createStubExchange({ budgetPerMin = 3000, windowMs = DEFAULT_WINDOW_MS, now = () => Date.now() } = {}) {
  const hits = [];
  const stats = { requests: 0, weight: 0, limited: 0, symbols_served: 0, peak_usage: 0, limited_at: [] };
  const prune = (t) => { while (hits.length && t - hits[0].at >= windowMs) hits.shift(); };
  const usage = (t) => { prune(t); return hits.reduce((n, h) => n + h.weight, 0); };

  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    const symbols = (u.searchParams.get("symbols") ?? "").split(",").filter(Boolean);
    const weight = Math.max(1, symbols.length); // weight 1 per symbol (A-02)
    const t = now();
    stats.requests++;
    stats.peak_usage = Math.max(stats.peak_usage, usage(t));
    if (usage(t) + weight > budgetPerMin) {
      stats.limited++;
      stats.limited_at.push({ at: t, usage: usage(t), weight });
      res.writeHead(429, {
        "content-type": "application/json",
        "X-Api-Limit-Reset-Timestamp": String(t + windowMs),
      });
      res.end(JSON.stringify({ code: -1003, msg: "TOO_MANY_REQUESTS" }));
      return;
    }
    hits.push({ at: t, weight });
    stats.weight += weight;
    stats.symbols_served += symbols.length;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(symbols.map((s, i) => ({ s, p: String(1000 + i) }))));
  });

  return {
    server,
    stats,
    usage,
    reset() { hits.length = 0; },
    listen(port = 0) {
      return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server.address().port)));
    },
    close() { return new Promise((resolve) => server.close(() => resolve())); },
  };
}

/** Generate N synthetic symbols (uppercase, deterministic order). */
export function syntheticSymbols(n) {
  return Array.from({ length: n }, (_, i) => `SYM${String(i).padStart(3, "0")}USDT`);
}
