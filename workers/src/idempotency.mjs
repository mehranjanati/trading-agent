// idempotency.mjs — E05-T01-S3: Idempotency-Key store (D1-backed in prod,
// in-memory for local/test). Same key + same route → same stored response.
export function createStore() {
  const mem = new Map(); // key: `${route}|${idemKey}` → {status, body}
  return {
    async lookup(route, key) {
      if (!key) return null;
      return mem.get(`${route}|${key}`) ?? null;
    },
    async save(route, key, status, body) {
      if (!key) return;
      mem.set(`${route}|${key}`, { status, body });
    },
  };
}
