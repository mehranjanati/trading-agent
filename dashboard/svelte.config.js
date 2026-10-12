// svelte.config.js — E10-T01-S1: adapter-cloudflare per docs/09 §9.5 (Q-01 closed).
import adapterCloudflare from "@sveltejs/adapter-cloudflare";
import adapterNode from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** PRODUCTION adapter is adapter-cloudflare (Pages/Workers). A node adapter is
 *  selectable ONLY for local render proof: adapter-cloudflare's dev/preview path
 *  needs workerd, which cannot run on macOS < 13.5 (same limitation as
 *  `wrangler dev`, recorded in docs/ops/DRILLS.md). Select it with
 *  `DASH_ADAPTER=node` — it is never what deploys. */
const adapter = process.env.DASH_ADAPTER === "node" ? adapterNode() : adapterCloudflare();

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter,
    // The dashboard is a BFF READ-ONLY client: it never submits an order.
    // Order paths live in Workers only (docs/02 §2.2, D-08) — enforced here by
    // simply not wiring any POST to /api/orders:intents or /api/approvals.
  },
};

export default config;