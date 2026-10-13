<script lang="ts">
  import Badge from "./Badge.svelte";

  /** Generic read-only data page: title, one freshness badge for the whole
   *  widget, and a table. An unsuccessul fetch renders UNAVAILABLE — never a
   *  blank table that looks like "no data" (docs/09 §9.4). */
  export let title: string;
  export let result: { ok: boolean; error?: string } | null = null;
  export let badge: { label: string; tone: string; age_s: number | null } | null = null;
  export let columns: { key: string; label: string }[] = [];
  export let rows: Record<string, unknown>[] = [];
</script>

<section class="data-page">
  <header>
    <h2>{title}</h2>
    {#if badge}<Badge label={badge.label} tone={badge.tone} age_s={badge.age_s} />{/if}
  </header>

  {#if result && !result.ok}
    <div class="unavailable">
      <span class="unavailable-label">UNAVAILABLE</span>
      <span class="unavailable-error">— {result.error}</span>
    </div>
  {:else if rows.length === 0}
    <p class="empty">no rows</p>
  {:else}
    <div class="table-wrap">
      <table>
        <thead>
          <tr>{#each columns as c}<th>{c.label}</th>{/each}</tr>
        </thead>
        <tbody>
          {#each rows as row}
            <tr>{#each columns as c}<td>{row[c.key] ?? "—"}</td>{/each}</tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>

<style>
  .data-page {
    background: #11151c;
    border: 1px solid #1e2330;
    border-radius: 10px;
    padding: 16px 20px;
    margin-bottom: 16px;
  }

  header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 12px;
  }

  h2 {
    font-size: 0.95rem;
    font-weight: 600;
    color: #e6e9ef;
    margin: 0;
  }

  .table-wrap {
    overflow-x: auto;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.82rem;
  }

  th, td {
    text-align: left;
    padding: 6px 10px;
    border-bottom: 1px solid #1e2330;
    white-space: nowrap;
  }

  th {
    color: #8b949e;
    font-weight: 500;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  td {
    color: #c9d1d9;
    font-family: "SF Mono", "Fira Code", monospace;
    font-size: 0.8rem;
  }

  tbody tr:hover {
    background: #161b22;
  }

  .unavailable {
    padding: 12px 0;
    font-size: 0.9rem;
  }

  .unavailable-label {
    color: #ef4444;
    font-weight: 700;
    font-size: 0.85rem;
  }

  .unavailable-error {
    color: #ef4444;
    opacity: 0.85;
  }

  .empty {
    color: #6b7280;
    font-size: 0.85rem;
    padding: 12px 0;
  }
</style>