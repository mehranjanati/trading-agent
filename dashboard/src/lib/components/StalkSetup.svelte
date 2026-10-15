<script lang="ts">
  import { postWatch } from "$lib/api";
  import { stalkBody, type SetupProposal } from "$lib/stalk";

  // Shared human-gated Stalk card: advisory proposal in, explicit click out.
  // D-08 holds — the ONLY write is POST /api/watches, never orders/approvals.
  export let proposal: SetupProposal | null = null;
  export let invalidReason: string | null = null;
  export let contextLabel: string | null = null;

  let busy = false;
  let error: string | null = null;
  let watchId: string | null = null;

  async function stalk() {
    if (!proposal || busy || watchId) return;
    busy = true;
    error = null;
    const res = await postWatch(stalkBody(proposal));
    busy = false;
    if (res.ok) {
      watchId = (res.data as { id: string }).id;
    } else {
      error = `stalk failed: ${res.error}`;
    }
  }
</script>

{#if invalidReason}
  <div class="stalk stalk-invalid">
    <div class="stalk-title">setup proposal invalid</div>
    <div class="stalk-error">{invalidReason}</div>
  </div>
{:else if proposal}
  <div class="stalk">
    <div class="stalk-title">
      stalk {proposal.symbol} {proposal.direction}
      {#if contextLabel}<span class="stalk-ctx">{contextLabel}</span>{/if}
    </div>
    <div class="stalk-grid">
      <div>trigger <strong>{proposal.trigger_op} {proposal.trigger_price}</strong></div>
      <div>invalidation <strong>{proposal.inval_op} {proposal.invalidation_price}</strong></div>
    </div>
    {#if proposal.strategies?.length}
      <div class="stalk-meta">strategies: {proposal.strategies.map((s) => `${s.id}@${s.version ?? "latest"}`).join(", ")}</div>
    {/if}
    {#if proposal.timeframes?.length}
      <div class="stalk-meta">timeframes: {proposal.timeframes.join(", ")}</div>
    {/if}
    {#if watchId}
      <div class="stalk-ok">watch stalked: <a href="/watches">{watchId}</a> — entry watches ACTIVE, parent stays advisory until price touch</div>
    {:else}
      <button on:click={stalk} disabled={busy} class="primary">
        {busy ? "stalking..." : "Stalk this zone — تایید و ساخت"}
      </button>
    {/if}
    {#if error}<div class="stalk-error">{error}</div>{/if}
  </div>
{/if}

<style>
  .stalk {
    background: #11151c;
    border: 1px solid #1e2330;
    border-radius: 10px;
    padding: 14px 16px;
    margin-top: 12px;
  }
  .stalk-invalid { border-color: #ef4444; }
  .stalk-title { font-weight: 700; margin-bottom: 8px; }
  .stalk-ctx { font-weight: 400; font-size: 0.75rem; color: #8b949e; margin-left: 8px; }
  .stalk-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px; font-size: 0.9rem; }
  .stalk-meta { font-size: 0.8rem; color: #8b949e; margin-bottom: 4px; }
  .stalk button.primary {
    width: 100%; margin-top: 10px; padding: 10px 16px;
    background: #238636; border: 1px solid #238636; border-radius: 6px;
    color: #e6e9ef; font-weight: 600; cursor: pointer;
  }
  .stalk button.primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .stalk-error { margin-top: 8px; color: #ef4444; font-size: 0.85rem; }
  .stalk-ok { margin-top: 8px; color: #22c55e; font-size: 0.9rem; }
  .stalk-ok a { color: #22c55e; }
</style>
