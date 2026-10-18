<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import { getWatchesAll, getApprovals, getIntents, getPositions, postAnalyze, getRegistry, getAnalysis } from "$lib/api";
  import type { AnalyzeRequest, AnalyzeResponse } from "$lib/types";
  import { getSymbols } from "$lib/symbols";
  import { setups, touchSetup, deriveStatus, roomWatches, roomWatchIds, linkStrategyTo, unlinkStrategyFrom, toggleGroupLink } from "$lib/setups";
  import { proposalFromAnalyze } from "$lib/stalk";
  import { composeCatalog, selectableCatalog, PINNED_FALLBACK, entryKey, type LibraryEntry } from "$lib/library";
  import StalkSetup from "$lib/components/StalkSetup.svelte";
  $: symbol = String($page.params.symbol ?? "").toUpperCase();
  const SYM_RE = /^[A-Z]{2,12}USDT$/;
  let watches: any[] = [];
  let approvals: any[] = [];
  let intents: any[] = [];
  let positions: any[] = [];
  let runs: any[] = [];
  // The room's own selection: which strategies / groups are "in play" here. Both
  // were append-only before — a group could be linked from /strategies and never
  // removed, and `strategies` was written by nobody, so this card was permanently
  // empty. The picker below links from the pinned catalog; every row unlinks.
  let catalog: LibraryEntry[] = [];
  $: selectable = selectableCatalog(catalog);
  let pickStrategy = "";
  let tradeable: boolean | null = null;
  let direction: "LONG" | "SHORT" | "" = "";
  let analyzing = false;
  let analyzeErr: string | null = null;
  let result: AnalyzeResponse | null = null;
  // The pin this room analyzes with comes from the Go registry (the bytes the
  // runner executes), never a version frozen in this file; the checked-in
  // mirror is only the offline case and is labelled as such below.
  let pin = { id: PINNED_FALLBACK[0].id, version: PINNED_FALLBACK[0].version };
  let pinSource: "registry" | "fallback" = "fallback";
  $: stalkProposal = result ? proposalFromAnalyze(result, (direction || result.aggregate?.bias || "LONG") === "SHORT" ? "SHORT" : "LONG") : null;
  $: symWatches = roomWatches(watches, symbol);
  $: watchIds = roomWatchIds(watches, symbol);
  $: symApprovals = approvals.filter((a: any) => watchIds.includes(a.watch_id));
  $: symIntents = intents.filter((i: any) => watchIds.includes(i.watch_id));
  $: symRuns = runs.filter((r: any) => watchIds.includes(r.watch_id));
  $: activeCount = symWatches.filter((w: any) => w.status === "ACTIVE").length;
  $: symPosition = positions.find((p: any) => p.symbol === symbol);
  $: symStrategies = $setups[symbol]?.strategies ?? [];
  $: symGroups = $setups[symbol]?.groups ?? [];
  $: status = deriveStatus(symbol, { positions, watches, approvals, watchIds });
  function addStrategy() {
    const [id, v] = pickStrategy.split("@");
    if (!id) return;
    linkStrategyTo(symbol, { id, version: !v || v === "latest" ? undefined : v });
    pickStrategy = "";
  }
  // A triggered watch writes an analysis run; the room shows the bias the engine
  // decided (output_json) so the watch→analysis hand-off is readable without
  // leaving the room. Unparsable output is "-", never an invented bias.
  function biasOf(r: any): string {
    try { return JSON.parse(r.output_json)?.bias ?? "-"; } catch { return "-"; }
  }
  async function refresh() {
    const [w, a, i, p, s, r] = await Promise.all([getWatchesAll(), getApprovals(), getIntents(), getPositions(), getSymbols(), getAnalysis()]);
    if (w.ok) watches = (w.data as { watches: any[] }).watches;
    if (a.ok) approvals = (a.data as { approvals: any[] }).approvals;
    if (i.ok) intents = (i.data as { intents: any[] }).intents;
    if (p.ok) positions = (p.data as { positions: any[] }).positions;
    if (s.ok) tradeable = s.data.allowlist.includes(symbol);
    if (r.ok) runs = (r.data as { runs: any[] }).runs;
    const reg = await getRegistry();
    const { entries, source } = composeCatalog(reg.ok ? reg.data.strategies : null, []);
    catalog = entries;
    pinSource = source;
    if (source === "registry" && entries[0]) pin = { id: entries[0].id, version: entries[0].version };
  }
  async function runAnalyze() {
    analyzing = true; analyzeErr = null; result = null;
    const body: AnalyzeRequest = { symbol, direction: direction || undefined, strategies: [{ id: pin.id, version: pin.version, config: {} }] };
    const res = await postAnalyze(body);
    analyzing = false;
    if (!res.ok) { analyzeErr = res.error; return; }
    result = res.data;
    touchSetup(symbol, { analyzes: [...($setups[symbol]?.analyzes ?? []), res.data.id] });
  }
  onMount(() => { refresh(); const t = setInterval(refresh, 5000); return () => clearInterval(t); });
</script>
{#if !SYM_RE.test(symbol)}
  <div class="page"><div class="error">bad symbol — <a href="/setups">back to setups</a></div></div>
{:else}
  <div class="page">
    <header>
      <div>
        <h1>{symbol}</h1>
        <div class="badges">
          <span class="pill {status === 'OPEN' ? 'open' : status === 'STALKING' ? 'stalk' : status === 'AWAITING-APPROVAL' ? 'await' : 'idle'}">{status}</span>
          {#if tradeable === true}<span class="pill trade">tradeable</span>
          {:else if tradeable === false}<span class="pill venue">venue-only</span>{/if}
        </div>
      </div>
      <div class="actions">
        <button on:click={() => goto(`/chat?symbol=${symbol}`)} class="primary">open {symbol} chat</button>
        <a href="/setups">all setups</a>
      </div>
    </header>
    {#if symPosition && symPosition.size !== "0"}
      <section class="card attention">
        <h2>open position</h2>
        <div>size <strong>{symPosition.size}</strong> @ {symPosition.entry_px ?? "-"} (lev {symPosition.leverage ?? "-"})</div>
      </section>
    {/if}
    <div class="grid">
      <section class="card">
        <h2>strategies in play ({symStrategies.length})</h2>
        <div class="row-btns">
          <select bind:value={pickStrategy}>
            <option value="">add a strategy…</option>
            {#each selectable as e}<option value={entryKey(e.id, e.version)}>{e.label}{e.kind === "draft" ? " (draft)" : ""}</option>{/each}
          </select>
          <button class="primary" on:click={addStrategy} disabled={!pickStrategy}>link</button>
        </div>
        <div class="meta">
          pinned versions are immutable (ADR-009 — the runner executes exact bytes): changing behaviour means
          publishing a new id@version, which then shows up in this picker.
        </div>
        {#each symStrategies as s}
          {@const entry = catalog.find((e) => entryKey(e.id, e.version) === entryKey(s.id, s.version))}
          <div class="row">
            {s.id}@{s.version ?? "latest"}
            {#if entry?.status === "retired"}<span class="row-note">retired — this reference keeps working, it is just not offered for new work</span>{/if}
            <button class="mini" on:click={() => unlinkStrategyFrom(symbol, s)}>remove</button>
          </div>
        {/each}
        {#if symStrategies.length === 0}<p class="empty">no strategies linked yet — pick one above</p>{/if}
        <h2 class="sub">groups in play ({symGroups.length})</h2>
        {#each symGroups as g}
          <div class="row">
            group: {g}
            <button class="mini" on:click={() => toggleGroupLink(symbol, g)}>unlink</button>
          </div>
        {/each}
        {#if symGroups.length === 0}<p class="empty">no groups linked yet — link one from <a href="/strategies">/strategies</a></p>{/if}
      </section>
      <section class="card">
        <h2>quick analysis</h2>
        <div class="row-btns">
          <select bind:value={direction}>
            <option value="">any</option><option value="LONG">LONG</option><option value="SHORT">SHORT</option>
          </select>
          <button on:click={runAnalyze} disabled={analyzing} class="primary">{analyzing ? "analyzing..." : "analyze"}</button>
        </div>
        <div class="meta">
          strategy: {pin.id}@{pin.version} ·
          {pinSource === "registry" ? "live registry (Go plane)" : "OFFLINE MIRROR (go-watcher unreachable)"}
        </div>
        {#if analyzeErr}<div class="error">{analyzeErr}</div>{/if}
        {#if result}
          <div class="agg">aggregate <strong class={result.aggregate.bias.toLowerCase()}>{result.aggregate.bias}</strong> @ {result.aggregate.confidence}</div>
          <div class="meta" title="Σ confidence of the winning side ÷ verdicts (strategy-declared constants, not a fitted probability)">{result.aggregate.explanation}</div>
          {#if result.suggest_zones.source}
            <div class="meta">
              zones from {result.suggest_zones.source}{#if result.suggest_zones.bars} · {result.suggest_zones.bars} bars{/if}{#if result.suggest_zones.last} · last {result.suggest_zones.last}{/if}
            </div>
          {/if}
          <StalkSetup proposal={stalkProposal} contextLabel="from {result.id}" />
        {/if}
      </section>
    </div>
    <section class="card">
      <h2>watches ({symWatches.length}{#if symWatches.length !== activeCount} · {activeCount} active{/if})</h2>
      {#each symWatches as w}
        <div class="row">
          {w.id} - {w.direction} - <span class="wstatus {w.status.toLowerCase()}">{w.status}</span> - v{w.version}
          {#if w.status !== "ACTIVE"}<span class="row-note">left ACTIVE — kept here so the trade is not lost from view</span>{/if}
        </div>
      {/each}
      {#if symWatches.length === 0}<p class="empty">no watches for {symbol}</p>{/if}
    </section>
    <section class="card">
      <h2>analysis runs ({symRuns.length})</h2>
      {#each symRuns as r}<div class="row">{r.id} - <span class="wstatus {biasOf(r).toLowerCase()}">{biasOf(r)}</span> @ {r.confidence ?? "-"} - {r.model} - {r.at}</div>{/each}
      {#if symRuns.length === 0}<p class="empty">no analysis runs for {symbol} yet — a triggered watch writes one</p>{/if}
    </section>
    <section class="card">
      <h2>approvals ({symApprovals.length})</h2>
      {#each symApprovals as a}<div class="row">{a.id} - {a.decision} - {a.used_at ? "consumed" : "open"}</div>{/each}
      {#if symApprovals.length === 0}<p class="empty">no approvals for {symbol}</p>{/if}
    </section>
    <section class="card">
      <h2>orders ({symIntents.length})</h2>
      {#each symIntents as i}<div class="row">{i.id} - {i.side} {i.qty} - {i.status}</div>{/each}
      {#if symIntents.length === 0}<p class="empty">no orders for {symbol}</p>{/if}
    </section>
  </div>
{/if}
<style>
  .page { max-width: 1200px; margin: 0 auto; padding: 20px; }
  header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; }
  h1 { font-size: 1.6rem; margin: 0 0 8px; font-family: monospace; }
  h2 { font-size: 1rem; margin: 0 0 10px; }
  .badges { display: flex; gap: 6px; }
  .pill { font-size: 0.75rem; padding: 2px 10px; border-radius: 20px; border: 1px solid #30363d; color: #8b949e; }
  .pill.open { color: #22c55e; border-color: #22c55e; }
  .pill.stalk { color: #eab308; border-color: #eab308; }
  .pill.await { color: #f97316; border-color: #f97316; }
  .pill.idle { color: #6b7280; }
  .pill.trade { color: #22c55e; border-color: #22c55e; }
  .pill.venue { color: #6b7280; }
  .actions { display: flex; gap: 12px; align-items: center; }
  .actions a { color: #8b949e; font-size: 0.85rem; }
  button.primary { padding: 8px 16px; background: #238636; border: 1px solid #238636; border-radius: 6px; color: #e6e9ef; font-weight: 600; cursor: pointer; }
  button.primary:disabled { opacity: 0.5; }
  .card { background: #11151c; border: 1px solid #1e2330; border-radius: 10px; padding: 16px; margin-bottom: 16px; }
  .card.attention { border-color: #22c55e; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .row { font-size: 0.85rem; font-family: monospace; color: #c9d1d9; padding: 4px 0; border-bottom: 1px solid #1e2330; }
  .wstatus { font-weight: 700; }
  .wstatus.active { color: #eab308; }
  .wstatus.triggered, .wstatus.analyzed, .wstatus.approved, .wstatus.ordered { color: #60a5fa; }
  .wstatus.invalidated, .wstatus.expired, .wstatus.closed { color: #8b949e; }
  .wstatus.long { color: #22c55e; } .wstatus.short { color: #ef4444; } .wstatus.flat { color: #9ca3af; }
  .row-note { margin-left: 8px; color: #6b7280; font-size: 0.75rem; }
  .empty { color: #6b7280; font-size: 0.85rem; }
  .empty a { color: #60a5fa; }
  .row-btns { display: flex; gap: 8px; margin-bottom: 10px; }
  .row-btns select { padding: 8px 12px; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; color: #e6e9ef; }
  h2.sub { margin-top: 16px; font-size: 0.9rem; }
  .mini {
    margin-left: 8px; padding: 1px 8px; font-size: 0.7rem; background: none;
    border: 1px solid #30363d; border-radius: 20px; color: #8b949e; cursor: pointer;
  }
  .mini:hover { color: #ef4444; border-color: #ef4444; }
  .agg { font-size: 1.1rem; margin-bottom: 4px; }
  .agg .long { color: #22c55e; } .agg .short { color: #ef4444; } .agg .flat { color: #9ca3af; }
  .meta { font-size: 0.8rem; color: #8b949e; margin-bottom: 8px; }
  .error { padding: 10px; background: #2a0d0d; border: 1px solid #ef4444; border-radius: 6px; color: #ef4444; margin-bottom: 12px; }
  .error a { color: #ef4444; }
</style>
