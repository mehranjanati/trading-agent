<script lang="ts">
  import DataPage from "$lib/components/DataPage.svelte";
  import { onMount } from "svelte";
  import { getApprovals, badgeFor } from "$lib/api";
  import { countdown, badge, actionBlocker } from "$lib/freshness.mjs";

  export let data: { result: any } = { result: null };
  let result: any = data?.result ?? null;
  let health: any = null;
  async function refresh() {
    result = await getApprovals();
    void health;
  }
  onMount(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  });

  $: now = result?.ok ? Date.parse(result.at) : Date.now();
  $: rows = (result?.ok ? result.data.approvals : []).map((a: any) => {
    const c = countdown(a.expires_at, now);
    const blocker = actionBlocker({ priceAgeMs: null });
    return {
      id: a.id, watch_id: a.watch_id, decision: a.decision,
      state: a.used_at ? "consumed" : c.expired ? "expired" : a.decision === "approve" ? "granted" : "rejected",
      countdown: c.text, blocked_reason: blocker?.reason ?? "allowed",
    };
  });
  $: freshness = badge({ ageMs: result?.ok ? result.ageMs : null });
  void badgeFor;
</script>

<DataPage title="approvals queue (single-use, expiring)" result={result} badge={freshness} columns={[
  { key: "id", label: "approval" }, { key: "watch_id", label: "watch" }, { key: "decision", label: "decision" },
  { key: "state", label: "state" }, { key: "countdown", label: "expires in" }, { key: "blocked_reason", label: "action" },
]} rows={rows} />