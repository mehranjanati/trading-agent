<script lang="ts">
  import { onMount } from "svelte";
  import { postAnalyze, badgeFor } from "$lib/api";
  import type { AnalyzeRequest, AnalyzeResponse } from "$lib/types";
  import { proposalFromAnalyze } from "$lib/stalk";
  import StalkSetup from "$lib/components/StalkSetup.svelte";
  import Badge from "$lib/components/Badge.svelte";

  // Form state
  let symbol = "BTCUSDT";
  let direction: "LONG" | "SHORT" | "" = "";
  let timeframes = ["15m", "1h", "4h"];
  let usePosition = false;
  let position = { entry: "", size: "", leverage: 1 };
  let strategies = [{ id: "sma-cross", version: "0.1.0", config: {} }];
  let loading = false;
  let error: string | null = null;
  let result: AnalyzeResponse | null = null;

  $: stalkProposal = result ? proposalFromAnalyze(result, (direction || result.aggregate?.bias || "LONG") === "SHORT" ? "SHORT" : "LONG") : null;

  const availableStrategies = [
    { id: "sma-cross", version: "0.1.0", name: "SMA Cross (fast)", config: { fast_window: 2, slow_window: 3, min_confidence: 0.55 } },
    { id: "sma-cross", version: "0.2.0", name: "SMA Cross (slow)", config: { fast_window: 5, slow_window: 20, min_confidence: 0.6 } },
  ];

  function addStrategy() {
    strategies = [...strategies, { id: "sma-cross", version: "0.1.0", config: {} }];
  }

  function removeStrategy(i: number) {
    strategies = strategies.filter((_, idx) => idx !== i);
  }

  function updateStrategy(i: number, field: string, value: any) {
    const updated = [...strategies];
    updated[i] = { ...updated[i], [field]: value };
    strategies = updated;
  }

  async function runAnalysis() {
    loading = true;
    error = null;
    result = null;
    const body: AnalyzeRequest = {
      symbol,
      direction: direction || undefined,
      timeframes: timeframes.length ? timeframes : undefined,
      strategies,
      position: usePosition ? position : undefined,
    };
    const res = await postAnalyze(body);
    loading = false;
    if (!res.ok) {
      error = res.error;
      return;
    }
    result = res.data;
  }

  function toggleTf(tf: string) {
    if (timeframes.includes(tf)) {
      timeframes = timeframes.filter((t) => t !== tf);
    } else {
      timeframes = [...timeframes, tf];
    }
  }
</script>

<div class="page">
  <h1>deep analysis</h1>
  <p class="subtitle">advisory only — no orders, no approvals (D-08)</p>

  <section class="form">
    <div class="field">
      <label>symbol</label>
      <input type="text" bind:value={symbol} placeholder="BTCUSDT" />
    </div>

    <div class="field">
      <label>direction (optional)</label>
      <select bind:value={direction}>
        <option value="">any</option>
        <option value="LONG">LONG</option>
        <option value="SHORT">SHORT</option>
      </select>
    </div>

    <div class="field">
      <label>timeframes</label>
      <div class="checkboxes">
        {#each ["15m", "1h", "4h"] as tf}
          <label class="checkbox">
            <input type="checkbox" checked={timeframes.includes(tf)} on:change={() => toggleTf(tf)} />
            {tf}
          </label>
        {/each}
      </div>
    </div>

    <div class="field">
      <label class="checkbox">
        <input type="checkbox" bind:checked={usePosition} />
        include position context
      </label>
    </div>

    {#if usePosition}
      <div class="position-fields">
        <div class="field">
          <label>entry</label>
          <input type="text" bind:value={position.entry} placeholder="67234.5" />
        </div>
        <div class="field">
          <label>size</label>
          <input type="text" bind:value={position.size} placeholder="0.1" />
        </div>
        <div class="field">
          <label>leverage</label>
          <input type="number" bind:value={position.leverage} min="1" max="125" />
        </div>
      </div>
    {/if}

    <div class="field">
      <label>strategies</label>
      {#each strategies as s, i}
        <div class="strategy-row">
          <select value={s.id} on:change={(e) => updateStrategy(i, "id", e.currentTarget.value)}>
            {#each availableStrategies as opt}
              <option value={opt.id}>{opt.name} ({opt.version})</option>
            {/each}
          </select>
          <input type="text" value={s.version} on:change={(e) => updateStrategy(i, "version", e.currentTarget.value)} placeholder="version" />
          <button on:click={() => removeStrategy(i)} disabled={strategies.length === 1}>remove</button>
        </div>
      {/each}
      <button on:click={addStrategy} class="secondary">+ add strategy</button>
    </div>

    <button on:click={runAnalysis} disabled={loading} class="primary">
      {loading ? "analyzing..." : "run analysis"}
    </button>

    {#if error}
      <div class="error">{error}</div>
    {/if}
  </section>

  {#if result}
    <section class="results">
      <h2>aggregate</h2>
      <div class="aggregate-card">
        <div class="bias {result.aggregate.bias.toLowerCase()}">{result.aggregate.bias}</div>
        <div class="confidence">confidence: {result.aggregate.confidence}</div>
        <div class="stats">
          agree: {result.aggregate.agree} · disagree: {result.aggregate.disagree} · flat: {result.aggregate.flat} · errors: {result.aggregate.errors}
        </div>
        <div class="explanation">{result.aggregate.explanation}</div>
      </div>

      <h2>suggested zones ({result.suggest_zones.timeframe})</h2>
      <div class="zones-card">
        <div>ATR: {result.suggest_zones.atr}</div>
        <div>trigger LONG: {result.suggest_zones.trigger_long}</div>
        <div>inval LONG: {result.suggest_zones.inval_long}</div>
        <div>trigger SHORT: {result.suggest_zones.trigger_short}</div>
        <div>inval SHORT: {result.suggest_zones.inval_short}</div>
        <StalkSetup proposal={stalkProposal} contextLabel="from deep analysis {result.id}" />
      </div>

      <h2>per-strategy verdicts</h2>
      {#each result.verdicts as v}
        <div class="verdict-card">
          <div class="verdict-header">
            <strong>{v.strategy_id}@{v.strategy_version}</strong>
            <span class="timeframe">{v.timeframe}</span>
            <Badge label={v.result.status} tone={v.result.status === "SIGNAL" ? "green" : v.result.status === "ERROR" ? "red" : "grey"} />
          </div>
          <div class="decision">
            bias: <strong>{v.result.decision.bias}</strong> · confidence: {v.result.decision.confidence}
          </div>
          <div class="diagnostics">
            {v.result.diagnostics.reason}
          </div>
          <div class="meta">
            data: {v.data_source} · invocation: {v.invocation_id}
          </div>
        </div>
      {/each}
    </section>
  {/if}
</div>

<style>
  .page {
    max-width: 1200px;
    margin: 0 auto;
    padding: 20px;
  }
  h1 {
    font-size: 1.5rem;
    margin: 0 0 8px;
  }
  .subtitle {
    color: #8b949e;
    font-size: 0.85rem;
    margin: 0 0 24px;
  }
  .form {
    background: #11151c;
    border: 1px solid #1e2330;
    border-radius: 10px;
    padding: 20px;
    margin-bottom: 24px;
  }
  .field {
    margin-bottom: 16px;
  }
  label {
    display: block;
    font-size: 0.85rem;
    font-weight: 500;
    margin-bottom: 6px;
    color: #c9d1d9;
  }
  input[type="text"],
  input[type="number"],
  select {
    width: 100%;
    padding: 8px 12px;
    background: #0d1117;
    border: 1px solid #30363d;
    border-radius: 6px;
    color: #e6e9ef;
    font-size: 0.9rem;
  }
  input[type="checkbox"] {
    margin-right: 6px;
  }
  .checkboxes {
    display: flex;
    gap: 16px;
  }
  .checkbox {
    display: flex;
    align-items: center;
    font-size: 0.9rem;
  }
  .position-fields {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px;
    margin-top: 12px;
  }
  .strategy-row {
    display: grid;
    grid-template-columns: 2fr 1fr auto;
    gap: 8px;
    margin-bottom: 8px;
  }
  button {
    padding: 10px 16px;
    background: #21262d;
    border: 1px solid #30363d;
    border-radius: 6px;
    color: #e6e9ef;
    font-size: 0.9rem;
    cursor: pointer;
    transition: background 0.15s;
  }
  button:hover:not(:disabled) {
    background: #30363d;
  }
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  button.primary {
    background: #238636;
    border-color: #238636;
    font-weight: 600;
  }
  button.primary:hover:not(:disabled) {
    background: #2ea043;
  }
  button.secondary {
    background: transparent;
    border: 1px dashed #30363d;
  }
  .error {
    margin-top: 12px;
    padding: 10px;
    background: #2a0d0d;
    border: 1px solid #ef4444;
    border-radius: 6px;
    color: #ef4444;
    font-size: 0.85rem;
  }
  .results {
    display: flex;
    flex-direction: column;
    gap: 20px;
  }
  h2 {
    font-size: 1.1rem;
    margin: 0;
  }
  .aggregate-card,
  .zones-card,
  .verdict-card {
    background: #11151c;
    border: 1px solid #1e2330;
    border-radius: 10px;
    padding: 16px;
  }
  .bias {
    font-size: 1.5rem;
    font-weight: 700;
    margin-bottom: 8px;
  }
  .bias.long { color: #22c55e; }
  .bias.short { color: #ef4444; }
  .bias.flat { color: #9ca3af; }
  .confidence {
    font-size: 1rem;
    margin-bottom: 8px;
  }
  .stats {
    font-size: 0.85rem;
    color: #8b949e;
    margin-bottom: 8px;
  }
  .explanation {
    font-size: 0.85rem;
    color: #c9d1d9;
  }
  .zones-card div {
    margin-bottom: 6px;
    font-size: 0.9rem;
  }
  .verdict-header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 8px;
  }
  .timeframe {
    font-size: 0.8rem;
    color: #8b949e;
  }
  .decision {
    font-size: 0.9rem;
    margin-bottom: 8px;
  }
  .diagnostics {
    font-size: 0.85rem;
    color: #c9d1d9;
    margin-bottom: 8px;
  }
  .meta {
    font-size: 0.75rem;
    color: #6b7280;
  }
</style>
