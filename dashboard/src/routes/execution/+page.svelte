<script lang="ts">
  // /execution — the money view (docs/20 §20.2, E15-T01 S4 target).
  //
  // Replaces /approvals + /orders as ONE flow: approvals queue → intents →
  // orders → fills → positions. Still a READ-ONLY surface (D-08): grants
  // happen in the control plane, never here.
  import DataPage from "$lib/components/DataPage.svelte";
  import { onMount } from "svelte";
  import { badgeFor, getApprovals, getIntents, getPositions } from "$lib/api";
  import { approvalLines, intentLines } from "$lib/cockpit-core.mjs";

  export let data: { approvals?: any; result?: any; positions?: any } = {};

  let approvals: any = data?.approvals ?? null;
  let intents: any = data?.result ?? null;
  let positions: any = data?.positions ?? null;

  async function refresh() {
    const [a, i, p] = await Promise.all([getApprovals(), getIntents(), getPositions()]);
    approvals = a;
    intents = i;
    positions = p;
  }

  onMount(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  });

  // Portfolio-wide: every watch id that carries an approval or an intent.
  $: ids = Array.from(
    new Set<string>(
      [
        ...(intents?.ok ? intents.data.intents : []),
        ...(approvals?.ok ? approvals.data.approvals : []),
      ]
        .map((x: any) => x?.watch_id)
        .filter(Boolean),
    ),
  );
  $: aRows = approvalLines(approvals?.ok ? approvals.data.approvals : [], ids);
  $: iRows = intentLines(intents?.ok ? intents.data.intents : [], ids);
  $: pRows = (positions?.ok ? positions.data.positions : []).map((p: any) => ({
    symbol: p.symbol,
    size: p.size,
    entry_px: p.entry_px,
    leverage: p.leverage,
  }));
</script>

<DataPage title="approvals queue (single-use, expiring — grants happen in the control plane)" result={approvals} badge={badgeFor(approvals)} columns={[
  { key: "id", label: "approval" }, { key: "watch_id", label: "watch" }, { key: "decision", label: "decision" },
  { key: "state", label: "state" }, { key: "countdown", label: "expires in" }, { key: "approver", label: "by" },
]} rows={aRows} />

<DataPage title="orders (intents → orders → fills)" result={intents} badge={badgeFor(intents)} columns={[
  { key: "id", label: "intent" }, { key: "client_order_id", label: "client_order_id" }, { key: "status", label: "status" },
  { key: "side", label: "side" }, { key: "qty", label: "qty" }, { key: "leverage", label: "lev" },
]} rows={iRows} />

<DataPage title="positions (fills only)" result={positions} badge={badgeFor(positions)} columns={[
  { key: "symbol", label: "symbol" }, { key: "size", label: "size" }, { key: "entry_px", label: "entry" }, { key: "leverage", label: "lev" },
]} rows={pRows} />
