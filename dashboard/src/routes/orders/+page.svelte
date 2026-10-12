<script lang="ts">
  import DataPage from "$lib/components/DataPage.svelte";
  import { getIntents, getPositions } from "$lib/api";
  import { badge } from "$lib/freshness.mjs";
  import { onMount } from "svelte";

  export let data: { result: any; positions: any } = { result: null, positions: null };
  let result: any = data?.result ?? null;
  let pos: any = data?.positions ?? null;
  async function refresh() {
    result = await getIntents();
    pos = await getPositions();
  }
  onMount(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  });

  // SUBMIT_UNKNOWN is highlighted — docs/09 §9.1: reconcile state is the story.
  $: rows = (result?.ok ? result.data.intents : []).map((i: any) => ({
    id: i.id, client_order_id: i.client_order_id, status: i.status === "SUBMIT_UNKNOWN" ? "⚠ SUBMIT_UNKNOWN" : i.status,
    approval_id: i.approval_id, side: i.side, qty: i.qty, leverage: i.leverage,
  }));
  $: posRows = (pos?.ok ? pos.data.positions : []).map((p: any) => ({ symbol: p.symbol, size: p.size, entry_px: p.entry_px, leverage: p.leverage }));
  $: freshness = badge({ ageMs: result?.ok ? result.ageMs : null });

</script>

<DataPage title="orders (intents → orders → fills)" result={result} badge={freshness} columns={[
  { key: "id", label: "intent" }, { key: "client_order_id", label: "client_order_id" }, { key: "status", label: "status" },
  { key: "approval_id", label: "approval" }, { key: "side", label: "side" }, { key: "qty", label: "qty" }, { key: "leverage", label: "lev" },
]} rows={rows} />

<DataPage title="positions (fills only)" result={pos} badge={badge({ ageMs: pos?.ok ? pos.ageMs : null, source: pos?.ok ? "live" : "unavailable" })} columns={[
  { key: "symbol", label: "symbol" }, { key: "size", label: "size" }, { key: "entry_px", label: "entry" }, { key: "leverage", label: "lev" },
]} rows={posRows} />