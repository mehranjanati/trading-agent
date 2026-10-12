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

<section>
  <header>
    <h2>{title}</h2>
    {#if badge}<Badge label={badge.label} tone={badge.tone} age_s={badge.age_s} />{/if}
  </header>

  {#if result && !result.ok}
    <p class="error">UNAVAILABLE — {result.error}</p>
  {:else if rows.length === 0}
    <p class="empty">no rows</p>
  {:else}
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
  {/if}
</section>

<style>
  header { display: flex; align-items: center; gap: 10px; }
  h2 { font-size: 1rem; margin: 0 0 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #262b36; }
  th { color: #9ca3af; font-weight: 500; }
  .error { color: #ef4444; }
  .empty { color: #9ca3af; }
</style>