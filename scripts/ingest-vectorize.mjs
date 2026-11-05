// scripts/ingest-vectorize.mjs — offline ingestion for RAG semantic search (Vectorize).
//
// Reads docs/*.md, docs/decisions/*.md and selected docs/ops/*.md, splits each
// file into section-level chunks, generates embeddings via Workers AI embedding
// model (@cf/baai/bge-m3), and upserts vectors to the Vectorize index.
// Writes mapping rows to D1 table `rag_doc_vectors` (migrations/0013) so the
// Worker can skip re-ingesting unchanged chunks.
//
// REQUIRES: Cloudflare environment with `VECTORIZE` vectorize binding and `DB`
// D1 binding (runs under `wrangler dev` or deployed Worker). Not plain Node.
//
// One-time index creation (before enabling the binding):
//   make vectorize-index      # or: wrangler vectorize create rag-docs-index --dimensions=1024 --metric=cosine
// (bge-m3 emits 1024-dim vectors; change --dimensions if AI_EMBEDDING_MODEL changes.)
// The [[vectorize]] binding ships COMMENTED in wrangler.toml — uncomment it only
// after the index exists, else `wrangler deploy` fails closed (code 10159).
// Then apply migrations 0012+0013 and POST to this module's route to ingest.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const ROOT = process.cwd();
const DOCS_DIRS = [
  join(ROOT, "docs"),
  join(ROOT, "docs", "decisions"),
  join(ROOT, "docs", "ops"),
];
const OPS_ALLOWLIST = [
  "TOOBIT-API-FACTS.md",
  "RBAC-MATRIX.md",
  "CONFIG-MATRIX.md",
  "SECRET-STORE.md",
  "GIT-DEPLOYS.md",
];

function mdFiles(dir) {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => join(dir, f))
      .sort();
  } catch { return []; }
}

const files = DOCS_DIRS.flatMap((d) =>
  mdFiles(d).filter((f) => {
    if (d.endsWith("ops")) return OPS_ALLOWLIST.includes(f.split("/").pop());
    return true;
  })
);

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function sqlLit(s) {
  return "'" + String(s ?? "").replace(/'/g, "''") + "'";
}

function chunkBySection(path, text) {
  const title = path.split("/").pop().replace(/\.md$/, "");
  const lines = text.split("\n");
  const chunks = [];
  let currentSection = null;
  let currentBuf = [];

  const flush = () => {
    if (currentBuf.join("\n").trim()) {
      chunks.push({
        section: currentSection ?? "(overview)",
        content: currentBuf.join("\n").trim(),
      });
    }
    currentBuf = [];
  };

  for (const line of lines) {
    const m = line.match(/^##\s+(.+)$/);
    if (m) {
      flush();
      currentSection = m[1].trim();
    } else {
      currentBuf.push(line);
    }
  }
  flush();

  if (!chunks.length) {
    chunks.push({ section: "(overview)", content: text.trim() });
  }

  
/** Generate embeddings for texts via Workers AI embedding model. */
async function embedTexts(env, texts, model) {
  const embeddings = [];
  for (const t of texts) {
    const res = await env.AI.run(model, { text: t });
    const data = res?.data ?? res?.embeddings ?? res;
    const vec = Array.isArray(data) ? data[0]?.embedding : data?.embedding;
    if (!vec || !Array.isArray(vec)) {
      throw new Error(`embedding model returned unexpected shape: ${JSON.stringify(res).slice(0, 200)}`);
    }
    embeddings.push(vec);
  }
  return embeddings;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }

    if (!env.VECTORIZE) {
      return new Response("VECTORIZE binding not configured", { status: 501 });
    }
    if (!env.DB) {
      return new Response("DB binding not configured", { status: 501 });
    }

    const model = env.AI_EMBEDDING_MODEL ?? "@cf/baai/bge-m3";

    // 1. Load all doc chunks
    const allChunks = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      const path = f.replace(ROOT + "/", "");
      allChunks.push(...chunkBySection(path, text));
    }

    // 2. Determine which chunks need (re)ingest — compare content_hash in D1
    const existing = await env.DB.prepare(
      "SELECT id, content_hash FROM rag_doc_vectors"
    ).all().catch(() => ({ results: [] }));
    const existingById = new Map();
    for (const r of existing.results ?? []) {
      existingById.set(r.id, r.content_hash);
    }

    const toUpsert = allChunks.filter((c) => {
      const prev = existingById.get(c.id);
      return !prev || prev !== c.content_hash;
    });

    if (!toUpsert.length) {
      return new Response(JSON.stringify({ status: "uptodate", chunks: allChunks.length }), {
        headers: { "content-type": "application/json" },
      });
    }

    // 3. Generate embeddings in batches (embedding model accepts one text per call usually)
    const texts = toUpsert.map((c) => c.content);
    const vectors = await embedTexts(env, texts, model);

    // 4. Upsert to Vectorize
    const points = toUpsert.map((c, i) => ({
      id: c.id,
      values: vectors[i],
      metadata: {
        path: c.path,
        title: c.title,
        section: c.section,
        content: c.content.slice(0, 500),
        chunk_idx: c.chunk_idx,
      },
    }));

    await env.VECTORIZE.upsert(points);

    // 5. Upsert mapping rows into D1 (idempotent)
    for (const c of toUpsert) {
      await env.DB.prepare(
        `INSERT OR REPLACE INTO rag_doc_vectors(id, vector_id, chunk_idx, content_hash, updated_at)
         VALUES(?, ?, ?, ?, ?)`
      ).bind(c.id, c.id, c.chunk_idx, c.content_hash, c.updated_at).run();
    }

    return new Response(JSON.stringify({
      status: "ingested",
      upserted: toUpsert.length,
      total: allChunks.length,
    }), {
      headers: { "content-type": "application/json" },
    });
  },
};
