<script lang="ts">
  import DataPage from "$lib/components/DataPage.svelte";
  import { onMount } from "svelte";
  import { getSignals, badgeFor } from "$lib/api";

  export let data: { result: any } = { result: null };
  let result: any = data?.result ?? null;
  async function refresh() { result = await getSignals(); }
  onMount(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  });

  $: rows = (result?.ok ? result.data.signals : []).map((s: any) => ({
    id: s.id, watch_id: s.watch_id ?? "—", kind: s.kind, source: s.source, at: s.at,
  }));
</script>

<DataPage title="signals" result={result} badge={badgeFor(result)} columns={[
  { key: "id", label: "id" }, { key: "watch_id", label: "watch" }, { key: "kind", label: "kind" },
  { key: "source", label: "source" }, { key: "at", label: "at" },
]} rows={rows} />