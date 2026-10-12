<script lang="ts">
  import DataPage from "$lib/components/DataPage.svelte";
  import { onMount } from "svelte";
  import { getStrategies, badgeFor } from "$lib/api";
  import { badge } from "$lib/freshness.mjs";

  export let data: { result: any } = { result: null };
  let result: any = data?.result ?? null;
  async function refresh() { result = await getStrategies(); }
  onMount(() => {
    refresh();
    const t = setInterval(refresh, 60_000);
    return () => clearInterval(t);
  }); // versioned config: rarely changes

  // The activator is admin-only in Workers (RBAC matrix); the dashboard shows
  // the versions and their config diffs but NEVER activates — it has no button.
  $: rows = (result?.ok ? result.data.versions : []).map((v: any) => {
    let max_lev = "—", max_not = "—", sources = "—";
    try {
      const c = JSON.parse(v.config_json ?? "{}");
      max_lev = c.max_leverage ?? "—"; max_not = c.max_notional_usd ?? "—";
      sources = c.signal_sources ? Object.keys(c.signal_sources).join(",") : "(default: none)";
    } catch { /* unparsable config shown as-is below */ }
    return { version: v.version, activated_by: v.activated_by, at: v.at, max_lev, max_not, sources };
  });
  $: freshness = badge({ ageMs: result?.ok ? result.ageMs : null });
  void badgeFor;
</script>

<DataPage title="strategy versions (admin activates in Workers, not here)" result={result} badge={freshness} columns={[
  { key: "version", label: "version" }, { key: "activated_by", label: "by" }, { key: "at", label: "at" },
  { key: "max_lev", label: "max lev" }, { key: "max_not", label: "max notional" }, { key: "sources", label: "signal sources" },
]} rows={rows} />