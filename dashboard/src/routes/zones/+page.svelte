<script lang="ts">
  import DataPage from "$lib/components/DataPage.svelte";
  import { onMount } from "svelte";
  import { getWatches, badgeFor } from "$lib/api";
  // /zones: trigger/invalidation zones per watch — CACHED is acceptable with an
  // explicit age (docs/09 §9.1); zones change rarely, the badge says how old.
  export let data: { result: any } = { result: null };
  let result: any = data?.result ?? null;
  async function refresh() { result = await getWatches(); }
  onMount(() => {
    refresh();
    const t = setInterval(refresh, 60_000);
    return () => clearInterval(t);
  });

  $: rows = (result?.ok ? result.data.watches : []).map((w: any) => {
    const t = JSON.parse(w.trigger_json ?? "{}");
    const i = JSON.parse(w.invalidation_json ?? "{}");
    return { id: w.id, symbol: w.symbol, trigger: `${t.op ?? "?"} ${t.price ?? "?"}`, invalidation: `${i.op ?? "?"} ${i.price ?? "?"}` };
  });
</script>

<DataPage title="zones" result={result} badge={badgeFor(result)} columns={[
  { key: "id", label: "watch" }, { key: "symbol", label: "symbol" },
  { key: "trigger", label: "trigger zone" }, { key: "invalidation", label: "invalidation" },
]} rows={rows} />