<script lang="ts">
  import { onMount } from "svelte";
  import { getSymbols, isTradeable, validateSymbolInput, type SymbolsData } from "$lib/symbols";
  import { getWatchesAll, getApprovals, getPositions, getPrices, badgeFor, type PricesData } from "$lib/api";
  import { setups, deriveStatus, roomWatchIds, type SetupStatus } from "$lib/setups";
  import DataPage from "$lib/components/DataPage.svelte";
  import Badge from "$lib/components/Badge.svelte";
  import { goto } from "$app/navigation";

  // /setups — the trading desk: every venue symbol from Toobit, each opening
  // its own room (chat + analysis + watches + approvals + orders + positions).
  let symbols: SymbolsData | null = null;
  let symErr: string | null = null;
  let watches: any[] = [];
  let approvals: any[] = [];
  let positions: any[] = [];
  // Live venue prices, one unfiltered weight-1 venue request per refresh (the
  // Worker serves the whole map, 5s in-isolate cache). Absent key = unanswered —
  // the card shows "—", never a stale invented number.
  let prices: Record<string, string> = {};
  let filter = "";
  let custom = "";

  $: rooms = $setups;
  $: list = (symbols?.symbols ?? []).filter((s) => !filter.trim() || s.includes(filter.trim().toUpperCase()));

  function statusOf(symbol: string): SetupStatus {
    const watchIds = roomWatchIds(watches, symbol);
    return deriveStatus(symbol, { positions, watches, approvals, watchIds });
  }

  function open(symbol: string) {
    goto(`/setups/${symbol}`);
  }

  function openCustom() {
    const s = validateSymbolInput(custom);
    if (s) open(s);
    else symErr = symErr ?? "custom symbol must match ^[A-Z]{2,12}USDT$";
  }

  async function refresh() {
    const r = await getSymbols();
    if (r.ok) { symbols = r.data; symErr = null; }
    else { symbols = null; symErr = r.error; }
    const [w, a, p, px] = await Promise.all([getWatchesAll(), getApprovals(), getPositions(), getPrices()]);
    if (w.ok) watches = (w.data as { watches: any[] }).watches;
    if (a.ok) approvals = (a.data as { approvals: any[] }).approvals;
    if (p.ok) positions = (p.data as { positions: any[] }).positions;
    if (px.ok) prices = (px.data as PricesData).prices;
  }

  onMount(() => {
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  });
</script>

<div class="page">
  <h1>trading setups</h1>
  <p class="subtitle">venue symbols from Toobit — each opens its own room (chat + analysis + orders)</p>

  {#if symErr}
    <div class="error">symbols UNAVAILABLE — {symErr}</div>
  {/if}
  {#if symbols?.stale}
    <div class="stale">symbol list is stale-cached (venue unreachable) — tradeable badges may lag</div>
  {/if}

  <section class="toolbar">
    <input type="text" bind:value={filter} placeholder="filter (e.g. BTC)" />
    <input type="text" bind:value={custom} placeholder="open custom: XRPUSDT" />
    <button on:click={openCustom}>open</button>
  </section>

  {#if !symbols}
    <DataPage title="symbols" result={{ ok: false, error: symErr ?? "loading" }} badge={badgeFor(null)} columns={[]} rows={[]} />
  {:else}
    <section class="grid">
      {#each list as s}
        {@const st = statusOf(s)}
        {@const tradeable = isTradeable(symbols, s)}
        <button class="room" on:click={() => open(s)}>
          <div class="room-sym">{s}</div>
          <div class="room-px">{prices[s] ?? "—"}</div>
          <div class="room-badges">
            <span class="pill {st === 'OPEN' ? 'open' : st === 'STALKING' ? 'stalk' : st === 'AWAITING-APPROVAL' ? 'await' : 'idle'}">{st}</span>
            <span class="pill {tradeable ? 'trade' : 'venue'}" title={tradeable ? "in the active risk allowlist" : "venue-only: risk gate R-SYM would reject"}>{tradeable ? "tradeable" : "venue-only"}</span>
            {#if rooms[s]}<span class="pill room-known">room</span>{/if}
          </div>
        </button>
      {/each}
    </section>
    {#if list.length === 0}<p class="empty">no symbols match</p>{/if}
  {/if}
</div>

<style>
  .page { max-width: 1200px; margin: 0 auto; padding: 20px; }
  h1 { font-size: 1.5rem; margin: 0 0 8px; }
  .subtitle { color: #8b949e; font-size: 0.85rem; margin: 0 0 24px; }
  .toolbar { display: flex; gap: 8px; margin-bottom: 16px; }
  .toolbar input {
    padding: 8px 12px; background: #0d1117; border: 1px solid #30363d;
    border-radius: 6px; color: #e6e9ef; font-size: 0.9rem;
  }
  .toolbar input:first-child { flex: 1; }
  .toolbar button {
    padding: 8px 16px; background: #21262d; border: 1px solid #30363d;
    border-radius: 6px; color: #e6e9ef; cursor: pointer;
  }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; }
  .room {
    background: #11151c; border: 1px solid #1e2330; border-radius: 10px;
    padding: 12px 14px; cursor: pointer; text-align: left; color: #e6e9ef;
  }
  .room:hover { border-color: #30363d; background: #161b22; }
  .room-sym { font-weight: 700; font-family: monospace; margin-bottom: 4px; }
  .room-px { font-family: monospace; font-size: 0.85rem; color: #c9d1d9; margin-bottom: 8px; }
  .room-badges { display: flex; flex-wrap: wrap; gap: 4px; }
  .pill { font-size: 0.7rem; padding: 2px 8px; border-radius: 20px; border: 1px solid #30363d; color: #8b949e; }
  .pill.open { color: #22c55e; border-color: #22c55e; }
  .pill.stalk { color: #eab308; border-color: #eab308; }
  .pill.await { color: #f97316; border-color: #f97316; }
  .pill.idle { color: #6b7280; }
  .pill.trade { color: #22c55e; border-color: #22c55e; }
  .pill.venue { color: #6b7280; }
  .pill.room-known { color: #60a5fa; border-color: #60a5fa; }
  .error { margin-bottom: 12px; padding: 10px; background: #2a0d0d; border: 1px solid #ef4444; border-radius: 6px; color: #ef4444; font-size: 0.85rem; }
  .stale { margin-bottom: 12px; padding: 10px; background: #2a220d; border: 1px solid #eab308; border-radius: 6px; color: #eab308; font-size: 0.85rem; }
  .empty { color: #6b7280; font-size: 0.85rem; }
</style>
