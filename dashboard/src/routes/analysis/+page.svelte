<script lang="ts">
  import DataPage from "$lib/components/DataPage.svelte";
  import { onMount } from "svelte";
  import { getAnalysis, badgeFor } from "$lib/api";
  // /analysis: CACHED + version is acceptable (docs/09 §9.1) — runs are advisory.
  export let data: { result: any } = { result: null };
  let result: any = data?.result ?? null;
  async function refresh() { result = await getAnalysis(); }
  onMount(() => {
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  });

  $: rows = (result?.ok ? result.data.runs : []).map((r: any) => {
    const out = JSON.parse(r.output_json ?? "{}");
    return { id: r.id, watch_id: r.watch_id, bias: out.bias, confidence: out.confidence, model: r.model, strategy_version: out.strategy_version ?? "—" };
  });
</script>

<DataPage title="analysis runs (advisory only)" result={result} badge={badgeFor(result)} columns={[
  { key: "id", label: "run" }, { key: "watch_id", label: "watch" }, { key: "bias", label: "bias" },
  { key: "confidence", label: "conf" }, { key: "model", label: "model" }, { key: "strategy_version", label: "version" },
]} rows={rows} />