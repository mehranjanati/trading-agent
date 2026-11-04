<script lang="ts">
  // /cockpit — the trading desk (docs/20 §20.3, E15-T01 S1+S2+S3).
  //
  // One surface: symbol sidebar (venue list + live price + derived room
  // status), the selected symbol's watch board (WHOLE lifecycle, ACTIVE
  // first), its approvals/orders/position, the advisory analysis panel with
  // the Stalk card, and the room's inline assistant.
  //
  // HARD RULES carried over unchanged (docs/20 §20.4):
  //   - one freshness badge per widget — merging routes never merges badges;
  //   - a failed read renders UNAVAILABLE, never a blank that looks like "no data";
  //   - read-only (D-08): the ONLY write on this page is POST /api/watches
  //     (Stalk). There is no approve/execute button here and none may be added
  //     without its own ADR + security review.
  import { onMount } from "svelte";
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import Badge from "$lib/components/Badge.svelte";
  import StalkSetup from "$lib/components/StalkSetup.svelte";
  import RoomChat from "$lib/components/RoomChat.svelte";
  import {
    getHealth,
    getWatchesAll,
    getApprovals,
    getIntents,
    getPositions,
    getPrices,
    postAnalyze,
    getRegistry,
    badgeFor as badgeForApi,
    type PricesData,
  } from "$lib/api";
  import {
    symbolBoard,
    filterSymbols,
    watchBoard,
    approvalLines,
    intentLines,
    aggregateSummary,
    priceOf,
  } from "$lib/cockpit-core.mjs";
  import { deriveStatus, roomWatchIds } from "$lib/setups";
  import { getSymbols, isTradeable, validateSymbolInput, type SymbolsData } from "$lib/symbols";
  import { proposalFromAnalyze, isVenueSourced } from "$lib/stalk";
  import { composeCatalog, selectableCatalog, PINNED_FALLBACK, type CatalogSource } from "$lib/library";
  import type { AnalyzeRequest, AnalyzeResponse } from "$lib/types";

  export let data: { cockpit?: any } = {};

  // Initial snapshot from SSR; afterwards the page refreshes itself.
  let snap: any = data?.cockpit ?? null;
  let filter = "";
  let custom = "";
  let customErr: string | null = null;

  type Strat = { id: string; version: string; config: Record<string, unknown> };

  // ── analysis form state (the compact /analyze panel) ─────────────────────────
  let direction: "LONG" | "SHORT" | "" = "";
  let timeframes: string[] = ["5m", "15m", "1h"];
  let regimeFilter = false;
  let usePosition = false;
  let position = { entry: "", size: "", leverage: 1 };
  let strategies: Strat[] = [];
  let analyzing = false;
  let analyzeError: string | null = null;
  let analysis: AnalyzeResponse | null = null;
  let catalogSource: CatalogSource | "loading" = "loading";
  let available: { id: string; version: string; name: string }[] = PINNED_FALLBACK.map((p: any) => ({
    id: p.id,
    version: p.version,
    name: p.name ?? p.id,
  }));

  async function refresh() {
    const [health, symbols, watches, approvals, intents, positions, prices] = await Promise.all([
      getHealth(),
      getSymbols(),
      getWatchesAll(),
      getApprovals(),
      getIntents(),
      getPositions(),
      getPrices(),
    ]);
    snap = { health, symbols, watches, approvals, intents, positions, prices };
  }

  async function bootCatalog() {
    const r = await getRegistry();
    const { entries, source } = composeCatalog(r.ok ? (r.data as any).strategies : null, []);
    catalogSource = source;
    if (source !== "registry") return; // keep the labelled mirror until the plane answers
    const selectable = selectableCatalog(entries as any[]);
    available = selectable.map((e: any) => ({ id: e.id, version: e.version, name: e.blurb || e.label }));
    // A pin the mirror carried but the registry does not must not stay selected.
    if (!selectable.some((e: any) => e.id === strategies[0]?.id && e.version === strategies[0]?.version) && selectable[0]) {
      strategies = [{ id: selectable[0].id, version: selectable[0].version, config: {} }];
    }
  }

  onMount(() => {
    void refresh();
    void bootCatalog();
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
  });

  // ── derived: the desk ────────────────────────────────────────────────────────
  $: symbolsData = (snap?.symbols?.ok ? snap.symbols.data : null) as SymbolsData | null;
  $: symbolsErr = snap?.symbols && !snap.symbols.ok ? snap.symbols.error : null;
  $: watches = (snap?.watches?.ok ? snap.watches.data.watches : []) as any[];
  $: watchesErr = snap?.watches && !snap.watches.ok ? snap.watches.error : null;
  $: approvals = (snap?.approvals?.ok ? snap.approvals.data.approvals : []) as any[];
  $: intents = (snap?.intents?.ok ? snap.intents.data.intents : []) as any[];
  $: positions = (snap?.positions?.ok ? snap.positions.data.positions : []) as any[];
  $: prices = (snap?.prices?.ok ? (snap.prices.data as PricesData).prices : {}) as Record<string, string>;
  $: pricesStale = snap?.prices?.ok ? (snap.prices.data as PricesData).stale === true : false;
  // Component strip: the old `/` overview's table, folded into the cockpit
  // header (docs/20 — the overview route now redirects here).
  $: health = (snap?.health?.ok ? snap.health.data : null) as any;
  $: components = (health?.components ?? []) as { component: string; status: string }[];

  $: board = symbolBoard({
    symbols: symbolsData?.symbols ?? null,
    allowlist: symbolsData?.allowlist ?? null,
    prices,
    watches,
    approvals,
    positions,
  });
  $: filtered = filterSymbols(board, filter);
  $: urlSymbol = validateSymbolInput($page.url.searchParams.get("symbol") ?? "") ?? "";
  $: symbol = urlSymbol || filtered.find((r) => r.status !== "IDLE")?.symbol || filtered[0]?.symbol || "BTCUSDT";

  $: tradeable = symbolsData ? isTradeable(symbolsData, symbol) : false;
  $: px = priceOf(prices, symbol);
  $: watchIds = roomWatchIds(watches, symbol);
  $: boardRows = watchBoard(watches, symbol);
  $: aLines = approvalLines(approvals, watchIds);
  $: iLines = intentLines(intents, watchIds);
  $: pos = positions.find((p: any) => p.symbol === symbol) ?? null;
  $: status = deriveStatus(symbol, { positions, watches, approvals, watchIds });

  function select(s: string) {
    const u = new URL($page.url.href);
    u.searchParams.set("symbol", s);
    goto(`${u.pathname}?${u.searchParams.toString()}`, { noScroll: true });
  }

  function openCustom() {
    const s = validateSymbolInput(custom);
    if (s) {
      customErr = null;
      custom = "";
      select(s);
    } else {
      customErr = "custom symbol must match ^[A-Z]{2,12}USDT$";
    }
  }

  // ── analysis actions ─────────────────────────────────────────────────────────
  function toggleTf(tf: string) {
    timeframes = timeframes.includes(tf) ? timeframes.filter((t) => t !== tf) : [...timeframes, tf];
  }

  function addStrategy() {
    const s = available[0];
    if (s) strategies = [...strategies, { id: s.id, version: s.version, config: {} }];
  }

  function removeStrategy(i: number) {
    strategies = strategies.filter((_, idx) => idx !== i);
  }

  function updateStrategy(i: number, field: "id" | "version", value: string) {
    const next = [...strategies];
    next[i] = { ...next[i], [field]: value };
    strategies = next;
  }

  async function runAnalysis() {
    analyzing = true;
    analyzeError = null;
    analysis = null;
    const body: AnalyzeRequest = {
      symbol,
      direction: direction || undefined,
      timeframes: timeframes.length ? timeframes : undefined,
      strategies: strategies.length
        ? strategies
        : [{ id: PINNED_FALLBACK[0].id, version: PINNED_FALLBACK[0].version, config: {} }],
      position: usePosition && position.entry && position.size ? position : undefined,
    };
    const res = await postAnalyze(body);
    analyzing = false;
    if (!res.ok) {
      analyzeError = res.error;
      return;
    }
    analysis = res.data;
  }

  $: agg = analysis ? aggregateSummary(analysis) : null;
  $: zones = analysis?.suggest_zones ?? null;
  $: zonesVenue = zones?.source ? isVenueSourced(zones.source) : false;
  $: stalkProposal = analysis
    ? proposalFromAnalyze(analysis, (direction || (analysis as any).aggregate?.bias || "LONG") === "SHORT" ? "SHORT" : "LONG")
    : null;

  // One badge per widget (docs/20 §20.3 rule 1): the watches, prices,
  // approvals and orders widgets each carry their OWN badge off their own
  // Result — merging the views must not merge the badges.
  $: watchesBadge = badgeForApi(snap?.watches ?? null);
  $: pricesBadge = badgeForApi(snap?.prices ?? null);
  $: approvalsBadge = badgeForApi(snap?.approvals ?? null);
  $: ordersBadge = badgeForApi(snap?.intents ?? null);
</script>

<div class="page">
  <h1>cockpit</h1>
  <p class="subtitle">one desk — sidebar · watch board · analysis · assistant (docs/20; read-only, D-08)</p>

  {#if symbolsData?.stale}
    <div class="warn">symbol list is stale-cached (venue unreachable) — tradeable badges may lag</div>
  {/if}

  <div class="shell">
    <aside class="sidebar">
      <input class="filter" type="text" bind:value={filter} placeholder="filter (e.g. BTC)" />
      <div class="custom">
        <input type="text" bind:value={custom} placeholder="open custom: XRPUSDT" on:keydown={(e) => e.key === "Enter" && openCustom()} />
        <button on:click={openCustom}>open</button>
      </div>
      {#if customErr}<div class="err">{customErr}</div>{/if}
      {#if !symbolsData && snap}
        <div class="unavail">symbols UNAVAILABLE — {symbolsErr ?? "loading"}</div>
      {/if}
      <div class="sym-list">
        {#each filtered as r (r.symbol)}
          <button
            class="sym {r.status.toLowerCase()}"
            class:selected={r.symbol === symbol}
            on:click={() => select(r.symbol)}
          >
            <span class="s-top"><span class="s-name">{r.symbol}</span><span class="s-px">{r.price ?? "—"}</span></span>
            <span class="s-badges">
              <span class="pill {r.status === 'OPEN' ? 'st-open' : r.status === 'STALKING' ? 'st-stalk' : r.status === 'AWAITING-APPROVAL' ? 'st-await' : 'st-idle'}">{r.status}</span>
              <span class="pill {r.tradeable ? 'trade' : 'venue'}" title={r.tradeable ? "in the active risk allowlist" : "venue-only: risk gate R-SYM would reject"}>{r.tradeable ? "tradeable" : "venue-only"}</span>
              {#if r.active}<span class="pill armed">{r.active} armed</span>{/if}
            </span>
          </button>
        {/each}
        {#if symbolsData && filtered.length === 0}<p class="empty">no symbols match</p>{/if}
      </div>
    </aside>

    <main>
      <header class="head">
        <div class="head-l">
          <h2 class="sym">{symbol}</h2>
          <span class="price">{px ?? "—"}</span>
          <Badge label={pricesBadge.label} tone={pricesBadge.tone} age_s={pricesBadge.age_s} />
        </div>
        <div class="head-r">
          <span class="pill {status === 'OPEN' ? 'st-open' : status === 'STALKING' ? 'st-stalk' : status === 'AWAITING-APPROVAL' ? 'st-await' : 'st-idle'}">{status}</span>
          <span class="pill {tradeable ? 'trade' : 'venue'}">{tradeable ? "tradeable" : "venue-only"}</span>
          {#if pos}
            <span class="pill open-pos">position {pos.size} @ {pos.entry_px ?? "—"}{pos.leverage ? ` · ${pos.leverage}x` : ""}</span>
          {/if}
        </div>
      </header>

      {#if components.length}
        <div class="comps" role="status" aria-label="component health">
          {#each components as c (c.component)}
            <span class="comp" class:bad={!/^(ok|healthy|live|primary)$/i.test(String(c.status))}>
              {c.component}<b>{c.status}</b>
            </span>
          {/each}
          {#if health?.at}<span class="comp-at">at {health.at}</span>{/if}
        </div>
      {/if}

      <section class="card">
        <div class="card-head">
          <h3>watches ({boardRows.length}) — whole lifecycle, ACTIVE first</h3>
          <Badge label={watchesBadge.label} tone={watchesBadge.tone} age_s={watchesBadge.age_s} />
        </div>
        {#if watchesErr}
          <div class="unavail">UNAVAILABLE — {watchesErr}</div>
        {:else if boardRows.length === 0}
          <p class="empty">no watches for {symbol} — run an analysis and Stalk a zone below</p>
        {:else}
          <div class="table-wrap">
            <table>
              <thead><tr><th>watch</th><th>dir</th><th>status</th><th>trigger</th><th>invalidation</th><th>regime</th><th>v</th><th>updated</th></tr></thead>
              <tbody>
                {#each boardRows as w (w.id)}
                  <tr>
                    <td class="mono">{w.id}</td>
                    <td><span class="dir {w.direction.toLowerCase()}">{w.direction}</span></td>
                    <td><span class="wstatus {w.status.toLowerCase()}">{w.status}</span></td>
                    <td class="mono">{w.trigger}</td>
                    <td class="mono">{w.invalidation}</td>
                    <td>{w.regime}</td>
                    <td>{w.version ?? "—"}</td>
                    <td class="mono dim">{w.updated_at ?? "—"}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </section>

      <div class="grid2">
        <section class="card">
          <div class="card-head">
            <h3>approvals ({aLines.length}) — single-use, expiring</h3>
            <Badge label={approvalsBadge.label} tone={approvalsBadge.tone} age_s={approvalsBadge.age_s} />
          </div>
          {#if aLines.length === 0}
            <p class="empty">no approvals for {symbol}</p>
          {:else}
            <div class="rows">
              {#each aLines as a (a.id)}
                <div class="row mono">
                  <span class="dim">{a.id}</span>
                  <span>{a.decision}</span>
                  <span class="state {a.state}">{a.state}</span>
                  <span class="cd">{a.countdown}</span>
                </div>
              {/each}
            </div>
            <p class="note">the dashboard never approves — grants happen in the control plane (D-08)</p>
          {/if}
        </section>

        <section class="card">
          <div class="card-head">
            <h3>orders ({iLines.length}) — intents → orders → fills</h3>
            <Badge label={ordersBadge.label} tone={ordersBadge.tone} age_s={ordersBadge.age_s} />
          </div>
          {#if iLines.length === 0}
            <p class="empty">no orders for {symbol}</p>
          {:else}
            <div class="rows">
              {#each iLines as i (i.id)}
                <div class="row mono">
                  <span class="dim">{i.id}</span>
                  <span>{i.side} {i.qty}</span>
                  <span class="status {String(i.status).includes('SUBMIT_UNKNOWN') ? 'unknown' : i.status.toLowerCase()}">{i.status}</span>
                  <span class="dim">{i.leverage}x</span>
                </div>
              {/each}
            </div>
          {/if}
        </section>
      </div>

      <section class="card">
        <div class="card-head">
          <h3>analysis — advisory engine (never an order path)</h3>
          <span class="catalog-note">pin: {catalogSource === "registry" ? "Go registry" : catalogSource === "loading" ? "loading" : "labelled offline mirror"}</span>
        </div>
        <div class="form">
          <label>direction
            <select bind:value={direction}>
              <option value="">engine decides</option>
              <option value="LONG">LONG</option>
              <option value="SHORT">SHORT</option>
            </select>
          </label>
          <span class="tfs">
            {#each ["5m", "15m", "1h", "4h"] as tf}
              <label class="chk"><input type="checkbox" checked={timeframes.includes(tf)} on:change={() => toggleTf(tf)} /> {tf}</label>
            {/each}
          </span>
          <label class="chk"><input type="checkbox" bind:checked={regimeFilter} /> regime filter (ETHBTC · USDT.D · BTC.D · TOTAL3)</label>
          <label class="chk"><input type="checkbox" bind:checked={usePosition} /> include open position</label>
          {#if usePosition}
            <input type="text" bind:value={position.entry} placeholder="entry" />
            <input type="text" bind:value={position.size} placeholder="size" />
            <input type="number" bind:value={position.leverage} min="1" placeholder="lev" />
          {/if}
        </div>
        <div class="strat-list">
          {#each strategies as s, i}
            <div class="strat-row">
              <select bind:value={s.id} on:change={() => updateStrategy(i, "id", s.id)}>
                {#each available as a (a.id + a.version)}
                  <option value={a.id}>{a.name} · {a.id}</option>
                {/each}
              </select>
              <select bind:value={s.version} on:change={() => updateStrategy(i, "version", s.version)}>
                {#each available.filter((a) => a.id === s.id) as a (a.version)}
                  <option value={a.version}>{a.version}</option>
                {/each}
              </select>
              <button class="mini" on:click={() => removeStrategy(i)}>remove</button>
            </div>
          {/each}
          <button class="mini add" on:click={addStrategy} disabled={!available.length}>+ strategy</button>
        </div>
        <div class="run-row">
          <button class="primary" on:click={runAnalysis} disabled={analyzing || !symbol}>{analyzing ? "analyzing…" : "run analysis"}</button>
          {#if analyzeError}<span class="err">analyze failed: {analyzeError}</span>{/if}
        </div>

        {#if analysis}
          <div class="agg">
            <span class="bias {agg?.bias.toLowerCase()}">{agg?.bias}</span>
            <span class="votes">agree {agg?.agree} · disagree {agg?.disagree} · flat {agg?.flat} · errors {agg?.errors} / {agg?.n}</span>
          </div>
          {#if agg?.explanation}<p class="explain">{agg.explanation}</p>{/if}
          <div class="verdicts">
            {#each analysis.verdicts as v (v.invocation_id)}
              <div class="row mono">
                <span>{v.strategy_id}@{v.strategy_version}</span>
                <span class="dim">{v.timeframe}</span>
                <span class="status {v.result.status.toLowerCase()}">{v.result.status}</span>
                <span>{v.result.decision.bias}</span>
                <span class="dim">conf {v.result.decision.confidence}</span>
                <span class="dim">src {v.data_source}</span>
              </div>
            {/each}
          </div>
          {#if zones}
            <div class="zones mono">
              zones (ATR): trigger {zones.trigger_long} / inval {zones.inval_long} (LONG) · trigger {zones.trigger_short} / inval {zones.inval_short} (SHORT)
              {#if zones.source}
                <div class:zones-warn={!zonesVenue}>zone source: {zones.source}{zonesVenue ? "" : " — NOT the Toobit trading venue; confirm the symbol is listed before stalking"}</div>
              {/if}
            </div>
          {/if}
          <StalkSetup proposal={stalkProposal} contextLabel="cockpit" bind:regimeFilter />
        {/if}
      </section>

      <RoomChat {symbol} />
    </main>
  </div>
</div>

<style>
  .page { max-width: 1280px; margin: 0 auto; padding: 20px; }
  .comps {
    display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
    margin: -4px 0 12px; font-size: 0.7rem; color: #8b949e;
  }
  .comp {
    border: 1px solid #30363d; border-radius: 20px; padding: 1px 8px;
    display: inline-flex; gap: 6px; color: #22c55e; border-color: #22c55e44;
  }
  .comp.bad { color: #ef4444; border-color: #ef444444; }
  .comp b { font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; }
  .comp-at { color: #6b7280; }
  h1 { font-size: 1.5rem; margin: 0 0 8px; }
  .subtitle { color: #8b949e; font-size: 0.85rem; margin: 0 0 20px; }
  .warn {
    margin-bottom: 12px; padding: 10px; background: #2a220d;
    border: 1px solid #eab308; border-radius: 6px; color: #eab308; font-size: 0.85rem;
  }
  .shell { display: grid; grid-template-columns: 260px 1fr; gap: 16px; align-items: start; }
  @media (max-width: 900px) { .shell { grid-template-columns: 1fr; } }
  .sidebar {
    background: #11151c; border: 1px solid #1e2330; border-radius: 10px;
    padding: 12px; display: flex; flex-direction: column; gap: 8px;
    position: sticky; top: 60px; max-height: calc(100vh - 90px); overflow-y: auto;
  }
  .sidebar input {
    padding: 8px 10px; background: #0d1117; border: 1px solid #30363d;
    border-radius: 6px; color: #e6e9ef; font-size: 0.85rem;
  }
  .custom { display: flex; gap: 6px; }
  .custom input { flex: 1; min-width: 0; }
  .custom button {
    padding: 8px 10px; background: #21262d; border: 1px solid #30363d;
    border-radius: 6px; color: #e6e9ef; cursor: pointer;
  }
  .sym-list { display: flex; flex-direction: column; gap: 4px; }
  .sym {
    background: none; border: 1px solid transparent; border-radius: 8px;
    padding: 8px; text-align: left; color: #e6e9ef; cursor: pointer;
  }
  .sym:hover { background: #161b22; border-color: #30363d; }
  .sym.selected { background: #1f2937; border-color: #388bfd66; }
  .s-top { display: flex; justify-content: space-between; gap: 8px; }
  .s-name { font-family: monospace; font-weight: 700; }
  .s-px { font-family: monospace; font-size: 0.8rem; color: #c9d1d9; }
  .s-badges { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
  .pill { font-size: 0.65rem; padding: 1px 8px; border-radius: 20px; border: 1px solid #30363d; color: #8b949e; }
  .pill.st-open, .pill.trade { color: #22c55e; border-color: #22c55e66; }
  .pill.st-stalk { color: #eab308; border-color: #eab30866; }
  .pill.st-await { color: #f97316; border-color: #f9731666; }
  .pill.st-idle, .pill.venue { color: #6b7280; }
  .pill.armed { color: #60a5fa; border-color: #60a5fa66; }
  .pill.open-pos { color: #22c55e; border-color: #22c55e66; }
  .head {
    display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 10px;
    background: #11151c; border: 1px solid #1e2330; border-radius: 10px; padding: 12px 16px; margin-bottom: 14px;
  }
  .head-l, .head-r { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  h2.sym { font-family: monospace; font-size: 1.4rem; margin: 0; }
  .price { font-family: monospace; font-size: 1.15rem; color: #e6e9ef; }
  main > .card, .grid2 { margin-bottom: 14px; }
  .card { background: #11151c; border: 1px solid #1e2330; border-radius: 10px; padding: 14px 16px; }
  .card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
  h3 { font-size: 0.9rem; margin: 0; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #1e2330; white-space: nowrap; }
  th { color: #8b949e; font-weight: 500; font-size: 0.7rem; text-transform: uppercase; }
  .mono { font-family: "SF Mono", "Fira Code", monospace; }
  .dim { color: #6b7280; }
  .dir.long, .wstatus.active, .bias.long { color: #22c55e; }
  .dir.short, .bias.short { color: #ef4444; }
  .wstatus.triggered, .wstatus.analyzed, .wstatus.approved, .wstatus.ordered { color: #60a5fa; }
  .wstatus.invalidated, .wstatus.expired, .wstatus.closed { color: #8b949e; }
  .bias.flat { color: #9ca3af; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  @media (max-width: 900px) { .grid2 { grid-template-columns: 1fr; } }
  .rows { display: flex; flex-direction: column; }
  .row { display: flex; gap: 10px; padding: 5px 0; border-bottom: 1px solid #1e2330; font-size: 0.78rem; flex-wrap: wrap; }
  .state.granted, .status.filled, .status.signal { color: #22c55e; }
  .state.expired, .state.rejected, .status.rejected, .status.error { color: #ef4444; }
  .state.consumed, .status.acked { color: #60a5fa; }
  .status.unknown { color: #eab308; font-weight: 700; }
  .cd { color: #f97316; }
  .empty { color: #6b7280; font-size: 0.85rem; }
  .unavail { color: #ef4444; font-size: 0.85rem; }
  .err { color: #ef4444; font-size: 0.8rem; }
  .note { color: #6b7280; font-size: 0.7rem; margin: 8px 0 0; }
  .catalog-note { color: #8b949e; font-size: 0.7rem; }
  .form { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin-bottom: 8px; }
  .form label { font-size: 0.8rem; color: #c9d1d9; display: flex; align-items: center; gap: 6px; }
  select, .form input {
    padding: 6px 8px; background: #0d1117; border: 1px solid #30363d;
    border-radius: 6px; color: #e6e9ef; font-size: 0.8rem;
  }
  .tfs { display: flex; gap: 10px; }
  .chk { display: flex; align-items: center; gap: 4px; }
  .strat-list { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
  .strat-row { display: flex; gap: 8px; }
  .mini {
    padding: 4px 10px; background: none; border: 1px solid #30363d;
    border-radius: 20px; color: #8b949e; font-size: 0.7rem; cursor: pointer;
  }
  .mini:hover { color: #ef4444; border-color: #ef4444; }
  .mini.add { align-self: flex-start; }
  .run-row { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
  button.primary {
    padding: 8px 16px; background: #238636; border: 1px solid #238636;
    border-radius: 6px; color: #e6e9ef; font-weight: 600; cursor: pointer;
  }
  button.primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .agg { display: flex; align-items: baseline; gap: 14px; margin: 6px 0; }
  .bias { font-size: 1.3rem; font-weight: 700; }
  .votes { color: #8b949e; font-size: 0.8rem; }
  .explain { color: #c9d1d9; font-size: 0.8rem; margin: 0 0 8px; }
  .verdicts .row { font-size: 0.75rem; }
  .zones { font-size: 0.78rem; color: #c9d1d9; padding: 8px 0; }
  .zones-warn { color: #eab308; }
</style>
