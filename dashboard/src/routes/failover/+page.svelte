<script lang="ts">
  import Timeline from "$lib/components/Timeline.svelte";
  import DataPage from "$lib/components/DataPage.svelte";
  import { onMount } from "svelte";
  import { getRecoveryLog, badgeFor } from "$lib/api";
  import { badge, timeline } from "$lib/freshness.mjs";

  export let data: { result: any } = { result: null };
  let result: any = data?.result ?? null;
  async function refresh() { result = await getRecoveryLog(200); }
  onMount(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  });

  $: incidents = (result?.ok ? result.data.incidents : []);
  $: drillRows = incidents.filter((i: any) => /drill|reconcile\.complete|kill\.|lease\.handoff|health\.recovered/.test(i.incident))
    .map((i: any) => ({ at: i.at, incident: i.incident, action: i.action, actor: i.actor }));
  $: leaseRows = incidents.filter((i: any) => /lease\.|kill\./.test(i.incident))
    .map((i: any) => ({ at: i.at, incident: i.incident, action: i.action }));
  $: rows = timeline(incidents.map((i: any) => ({ at: i.at, type: i.incident })), { nowMs: result?.ok ? Date.parse(result.at) : Date.now() });
  $: freshness = badge({ ageMs: result?.ok ? result.ageMs : null });
  void badgeFor;
</script>

<DataPage title="failover — incidents & drills" result={result} badge={freshness} columns={[
  { key: "at", label: "at" }, { key: "incident", label: "incident" }, { key: "action", label: "action" }, { key: "actor", label: "actor" },
]} rows={drillRows} />

<DataPage title="lease epochs & handoffs" result={result} badge={freshness} columns={[
  { key: "at", label: "at" }, { key: "incident", label: "event" }, { key: "action", label: "detail" },
]} rows={leaseRows} />

<Timeline rows={rows} badge={freshness} />