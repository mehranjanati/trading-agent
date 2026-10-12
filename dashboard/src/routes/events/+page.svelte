<script lang="ts">
  import DataPage from "$lib/components/DataPage.svelte";
  import { onMount } from "svelte";
  import { getRecoveryLog, badgeFor } from "$lib/api";
  import { timeline } from "$lib/freshness.mjs";

  export let data: { result: any } = { result: null };
  let result: any = data?.result ?? null;
  async function refresh() { result = await getRecoveryLog(100); }
  onMount(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  });

  $: entries = (result?.ok ? result.data.incidents : []).map((i: any) => ({ at: i.at, type: i.incident, action: i.action, actor: i.actor }));
  $: rows = timeline(entries, { nowMs: result?.ok ? Date.parse(result.at) : Date.now() });
</script>

<DataPage title="events / recovery timeline" result={result} badge={badgeFor(result)} columns={[
  { key: "at", label: "at" }, { key: "type", label: "incident" }, { key: "action", label: "action" }, { key: "actor", label: "actor" },
]} rows={entries} />

<p style="color:#9ca3af;font-size:0.8rem">gaps are shown explicitly — the timeline never interpolates (docs/09 §9.4)</p>