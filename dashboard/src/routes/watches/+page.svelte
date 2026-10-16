<script lang="ts">
  import DataPage from "$lib/components/DataPage.svelte";
  import { onMount } from "svelte";
  import { getWatches, badgeFor } from "$lib/api";
  import { badge } from "$lib/freshness.mjs";

  export let data: { result: any } = { result: null };
  let result: any = data?.result ?? null;
  async function refresh() { result = await getWatches(); }
  onMount(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  });

  // watches are LIVE only while the feed is fresh; STALE if px is old (docs/09)
  // `by` is the author of the row: a drill/seed watch is attributable instead of
  // anonymous (dev-server seeds carry created_by "e06-drill").
  $: rows = (result?.ok ? result.data.watches : []).map((w: any) => ({
    id: w.id, symbol: w.symbol, direction: w.direction, status: w.status, version: w.version,
    created_by: w.created_by,
  }));
  $: freshness = badgeFor(result);
  void badge;
</script>

<DataPage title="watches (ACTIVE)" result={result} badge={freshness} columns={[
  { key: "id", label: "id" }, { key: "symbol", label: "symbol" }, { key: "direction", label: "dir" },
  { key: "status", label: "status" }, { key: "version", label: "v" }, { key: "created_by", label: "by" },
]} rows={rows} />