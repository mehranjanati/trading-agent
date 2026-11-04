<script lang="ts">
  // /activity — the four timelines as ONE view (docs/20 §20.2, E15-T01 S4).
  //
  // Replaces /signals, /events, /logs and /failover. The filters are the SAME
  // regexes those pages applied (cockpit-core ERROR_RE / FAILOVER_RE, unit
  // tested) so the merge cannot silently change what "errors" means — and the
  // timeline still shows gaps explicitly instead of interpolating (docs/09 §9.4).
  import DataPage from "$lib/components/DataPage.svelte";
  import { onMount } from "svelte";
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import { badgeFor, getRecoveryLog, getSignals } from "$lib/api";
  import { incidentRows, signalRows, ACTIVITY_TABS } from "$lib/cockpit-core.mjs";
  import { timeline } from "$lib/freshness.mjs";

  export let data: { signals?: any; incidents?: any } = {};

  let signals: any = data?.signals ?? null;
  let incidents: any = data?.incidents ?? null;

  async function refresh() {
    const [s, i] = await Promise.all([getSignals(), getRecoveryLog(200)]);
    signals = s;
    incidents = i;
  }

  onMount(() => {
    refresh();
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
  });

  $: tabParam = ($page.url.searchParams.get("tab") ?? "events").toLowerCase();
  $: tab = (ACTIVITY_TABS as string[]).includes(tabParam) ? tabParam : "events";

  function pick(t: string) {
    const u = new URL($page.url.href);
    u.searchParams.set("tab", t);
    goto(`${u.pathname}?${u.searchParams.toString()}`, { noScroll: true });
  }

  $: sigRows = signalRows(signals?.ok ? signals.data.signals : []);
  $: allIncidents = incidents?.ok ? incidents.data.incidents : [];
  $: incRows = incidentRows(allIncidents, tab).map((i: any) => ({
    at: i.at,
    incident: i.incident,
    action: i.action,
    actor: i.actor ?? "—",
  }));
  // Gap-explicit timeline (docs/09 §9.4): the events tab shows where the log
  // actually has holes, never a bridged line.
  $: gaps = timeline(
    allIncidents.map((i: any) => ({ at: i.at, type: i.incident })),
    { nowMs: incidents?.ok ? Date.parse(incidents.at) : Date.now() },
  ).filter((r: any) => r.kind === "gap").length;
</script>

<div class="tabs">
  {#each ACTIVITY_TABS as t}
    <button class:active={tab === t} on:click={() => pick(t)}>{t}</button>
  {/each}
</div>

{#if tab === "signals"}
  <DataPage title="signals" result={signals} badge={badgeFor(signals)} columns={[
    { key: "id", label: "id" }, { key: "watch_id", label: "watch" }, { key: "kind", label: "kind" },
    { key: "source", label: "source" }, { key: "at", label: "at" },
  ]} rows={sigRows} />
{:else}
  <DataPage
    title={tab === "errors" ? "logs — errors, fencing, rate-limit" : tab === "failover" ? "failover — drills, lease epochs, reconcile" : "events / recovery timeline"}
    result={incidents}
    badge={badgeFor(incidents)}
    columns={[
      { key: "at", label: "at" }, { key: "incident", label: "incident" },
      { key: "action", label: "action" }, { key: "actor", label: "actor" },
    ]}
    rows={incRows}
  />
  <p class="page-note">
    the timeline never interpolates — {gaps} explicit gap(s) on this log (docs/09 §9.4). The
    filters are the same ones /logs and /failover applied before the merge.
  </p>
{/if}

<style>
  .tabs { display: flex; gap: 6px; margin-bottom: 14px; flex-wrap: wrap; }
  .tabs button {
    padding: 6px 14px; border-radius: 20px; border: 1px solid #30363d;
    background: #11151c; color: #8b949e; font-size: 0.8rem; cursor: pointer;
  }
  .tabs button:hover { color: #e6e9ef; }
  .tabs button.active { color: #e6e9ef; background: #1f2937; border-color: #388bfd66; }
  .page-note { color: #6b7280; font-size: 0.78rem; margin-top: 8px; padding-left: 4px; }
</style>
