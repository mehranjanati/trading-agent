<script lang="ts">
  import DataPage from "$lib/components/DataPage.svelte";
  import { onMount } from "svelte";
  import { getRecoveryLog, badgeFor } from "$lib/api";
  import { badge } from "$lib/freshness.mjs";

  export let data: { result: any } = { result: null };
  let result: any = data?.result ?? null;
  async function refresh() { result = await getRecoveryLog(200); }
  onMount(() => {
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }); // /logs is STALE-tolerant (docs/09 §9.1)

  $: errorRows = (result?.ok ? result.data.incidents : [])
    .filter((i: any) => /error|fenced|unknown|backoff|down/i.test(`${i.incident} ${i.action}`))
    .map((i: any) => ({ at: i.at, incident: i.incident, action: i.action }));
  $: freshness = badge({ ageMs: result?.ok ? result.ageMs : null, source: result?.ok ? "live" : "unavailable" });
  void badgeFor;
</script>

<p class="page-note">
  latency p50/p95 and data-gap metrics land with the E12 metrics wiring; this view is STALE-tolerant by design (docs/09 §9.1).
</p>

<DataPage title="logs — errors, fencing, rate-limit, gaps" result={result} badge={freshness} columns={[
  { key: "at", label: "at" }, { key: "incident", label: "incident" }, { key: "action", label: "action" },
]} rows={errorRows} />

<style>
  .page-note {
    color: #6b7280;
    font-size: 0.78rem;
    margin-bottom: 12px;
    padding-left: 4px;
  }
</style>