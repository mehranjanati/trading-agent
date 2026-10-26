<script lang="ts">
  import { postWatch } from "$lib/api";
  import { stalkBody, isVenueSourced, bandStats, fmtPct, type SetupProposal } from "$lib/stalk";

  // Shared human-gated Stalk card: advisory proposal in, explicit click out.
  // D-08 holds — the ONLY write is POST /api/watches, never orders/approvals.
  export let proposal: SetupProposal | null = null;
  export let invalidReason: string | null = null;
  export let contextLabel: string | null = null;

  export let regimeFilter = false;

  let busy = false;
  let error: string | null = null;
  let watchId: string | null = null;

  // How far the two armed prices sit from the close they were measured on. A
  // band a fraction of a percent wide is decided by the next tick, so the watch
  // leaves ACTIVE immediately — the distances are shown before the click.
  $: band = proposal ? bandStats(proposal) : null;

  async function stalk() {
    if (!proposal || busy || watchId) return;
    busy = true;
    error = null;
    const res = await postWatch({ ...stalkBody(proposal), regime_filter: regimeFilter });
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
    <div class="stalk-row">
      <label class="stalk-toggle">
        <input type="checkbox" bind:checked={regimeFilter} />
        regime filter (ETHBTC · USDT.D · BTC.D · TOTAL3)
      </label>
      {#if regimeFilter}
        <span class="stalk-cap">when enabled, a hostile regime forces FLAT / reduces confidence</span>
      {/if}
    </div>
    {#if proposal.zone_source}
      <div class="stalk-meta">
        zone data: {proposal.zone_source}{#if proposal.zone_bars} · {proposal.zone_bars} bars{/if}{#if proposal.zone_last} · last {proposal.zone_last}{/if}{#if proposal.zone_last_ts} ({proposal.zone_last_ts}){/if}
      </div>
      {#if !isVenueSourced(proposal.zone_source)}
        <div class="stalk-warn">⚠ zone measured on {proposal.zone_source}, not the Toobit trading venue — confirm {proposal.symbol} is listed on Toobit before stalking</div>
      {/if}
    {/if}
    {#if band}
      <div class="stalk-meta">
        band {band.width_pct.toFixed(3)}% of price — trigger {fmtPct(band.trigger_pct)}, invalidation {fmtPct(band.inval_pct)} from the {band.anchor} close
      </div>
      {#if band.in_play}
        <div class="stalk-warn">⚠ the trigger is only {fmtPct(band.trigger_pct)} from that close — the live price is already there, so the next tick fires (or invalidates) this watch instead of waiting. Stalk a level price has not reached yet if you want it to sit armed.</div>
      {/if}
    {/if}
    {#if proposal.strategies?.length}
      <div class="stalk-meta">strategies: {proposal.strategies.map((s) => `${s.id}@${s.version ?? "latest"}`).join(", ")}</div>
    {/if}
    {#if proposal.timeframes?.length}
      <div class="stalk-meta">timeframes: {proposal.timeframes.join(", ")}</div>
    {/if}
    {#if watchId}
      <div class="stalk-ok">
        watch armed: <a href="/watches">{watchId}</a> — status <strong>ACTIVE</strong> (published DRAFT→ACTIVE), so the trigger loop evaluates it now.
        A price touch fires a trigger → analysis; <strong>no order is placed without a separate single-use human approval</strong> (D-08: the dashboard deliberately cannot issue one).
      </div>
      {#if regimeFilter}
        <div class="stalk-meta">regime filter armed on this watch — the Worker checks ETHBTC · USDT.D · BTC.D · TOTAL3 at analysis time: a hostile regime stores FLAT @ confidence 0, CHOP/UNKNOWN reduces confidence.</div>
      {/if}
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
  .stalk-warn { margin-top: 6px; color: #eab308; font-size: 0.8rem; }
  .stalk-row { display: flex; align-items: center; gap: 10px; margin-top: 10px; font-size: 0.8rem; color: #8b949e; }
  .stalk-toggle { display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none; }
  .stalk-toggle input { accent-color: #238636; }
  .stalk-cap { font-size: 0.72rem; color: #6e7783; }
  .stalk-ok { margin-top: 8px; color: #22c55e; font-size: 0.9rem; }
  .stalk-ok a { color: #22c55e; }
</style>
