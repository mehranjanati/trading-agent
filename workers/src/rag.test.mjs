// rag.test.mjs — hybrid RAG retrieval (BM25 via FTS5 + semantic via Vectorize).
// Acceptance: (1) BM25 alone works when no VECTORIZE binding exists; (2) the
// two backends merge and de-duplicate; (3) either backend failing degrades to
// the other (never a throw — chat is advisory); (4) the injected block cites
// sources and marks semantic hits.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  retrieveDocs,
  retrieveDocsBm25,
  retrieveDocsSemantic,
  formatRagContext,
  RAG_LIMIT,
} from "./rag.mjs";

const bm25Row = (path, section, content = "text", score = -1) => ({ path, section, title: "doc", content, score });
const vecMatch = (path, section, content = "semantic text", score = 0.9) => ({
  score,
  metadata: { path, section, title: "doc", content, chunk_idx: 0 },
});

/** fakeEnv builds an env with optional D1 rows / AI + VECTORIZE bindings. */
function fakeEnv({ rows = [], matches = null, aiThrows = false } = {}) {
  const env = {
    DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }) },
  };
  if (matches) {
    env.AI = { run: async () => (aiThrows ? Promise.reject(new Error("ai down")) : { data: [{ embedding: [0.1, 0.2, 0.3] }] }) };
    env.VECTORIZE = { query: async () => ({ matches }) };
  }
  return env;
}

describe("rag — BM25 (FTS5)", () => {
  it("returns keyword rows normalised with source=bm25", async () => {
    const env = fakeEnv({ rows: [bm25Row("docs/08.md", "Risk", "kill switch rules")] });
    const out = await retrieveDocsBm25(env, "kill switch");
    assert.equal(out.length, 1);
    assert.equal(out[0].source, "bm25");
    assert.equal(out[0].path, "docs/08.md");
    assert.equal(out[0].section, "Risk");
    assert.match(out[0].content, /kill switch rules/);
  });

  it("fail-soft when D1 is missing or the table does not exist", async () => {
    assert.deepEqual(await retrieveDocsBm25({}, "x"), []);
    const broken = { DB: { prepare: () => { throw new Error("no such table: rag_docs_fts"); } } };
    assert.deepEqual(await retrieveDocsBm25(broken, "x"), []);
  });

  it("an empty query short-circuits (no query, no result)", async () => {
    const env = fakeEnv({ rows: [bm25Row("docs/08.md", "Risk")] });
    assert.deepEqual(await retrieveDocsBm25(env, "   "), []);
  });
});

describe("rag — semantic (Vectorize)", () => {
  it("embeds the query and maps Vectorize metadata back to a chunk", async () => {
    const env = fakeEnv({ matches: [vecMatch("docs/17.md", "Contract", "strategy-result-v1 envelope")] });
    const out = await retrieveDocsSemantic(env, "how do I shape the result JSON?");
    assert.equal(out.length, 1);
    assert.equal(out[0].source, "vector");
    assert.equal(out[0].path, "docs/17.md");
    assert.match(out[0].content, /strategy-result-v1/);
  });

  it("return [] without the VECTORIZE binding (fail-soft, BM25 keeps working)", async () => {
    const env = { AI: { run: async () => ({ data: [{ embedding: [0.1] }] }) } };
    assert.deepEqual(await retrieveDocsSemantic(env, "anything"), []);
  });

  it("return [] when the embedding call fails", async () => {
    const env = fakeEnv({ matches: [vecMatch("docs/17.md", "Contract")], aiThrows: true });
    assert.deepEqual(await retrieveDocsSemantic(env, "anything"), []);
  });
});

describe("rag — hybrid merge", () => {
  it("merges BM25 + semantic and de-duplicates the same section", async () => {
    const env = fakeEnv({
      rows: [bm25Row("docs/08.md", "Risk"), bm25Row("docs/19.md", "Runs")],
      matches: [vecMatch("docs/08.md", "Risk"), vecMatch("docs/21.md", "Live gate")],
    });
    const out = await retrieveDocs(env, "risk gate");
    const keys = out.map((c) => `${c.path}#${c.section}`);
    assert.deepEqual(keys, ["docs/08.md#Risk", "docs/19.md#Runs", "docs/21.md#Live gate"]);
    // BM25 wins ties: the duplicate section keeps its keyword provenance.
    assert.equal(out[0].source, "bm25");
    assert.equal(out[2].source, "vector");
  });

  it("respects the limit and still works with BM25 only", async () => {
    const rows = [bm25Row("docs/a.md", "A"), bm25Row("docs/b.md", "B"), bm25Row("docs/c.md", "C"), bm25Row("docs/d.md", "D"), bm25Row("docs/e.md", "E")];
    const out = await retrieveDocs(fakeEnv({ rows }), "query");
    assert.equal(out.length, RAG_LIMIT);
  });
});

describe("rag — injected block", () => {
  it("cites the source path and marks semantic hits", () => {
    const text = formatRagContext([
      { path: "docs/08.md", title: "08-risk", section: "Kill switch", content: "engages on drawdown", source: "bm25" },
      { path: "docs/21.md", title: "21-readiness", section: "Live gate", content: "signed release", source: "vector" },
    ]);
    assert.match(text, /RETRIEVED KNOWLEDGE/);
    assert.match(text, /\[08-risk › Kill switch\] \(docs\/08\.md\): engages on drawdown/);
    assert.match(text, /\[21-readiness › Live gate\] \(docs\/21\.md\) \[semantic\]: signed release/);
    assert.match(text, /END RETRIEVED KNOWLEDGE/);
  });

  it("returns null when nothing was retrieved (no empty system turn)", () => {
    assert.equal(formatRagContext([]), null);
    assert.equal(formatRagContext(null), null);
  });

  it("caps an oversized chunk so the 24K turn budget holds", () => {
    const text = formatRagContext([{ path: "p", title: "t", section: "s", content: "x".repeat(5000) }]);
    assert.ok(text.length < 1200, `chunk not capped: ${text.length}`);
    assert.ok(text.includes("…"));
  });
});
