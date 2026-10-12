<script lang="ts">
  import Badge from "./Badge.svelte";
  export let badge: { label: string; tone: string; age_s: number | null } | null = null;
  export let rows: ({ kind: string } & Record<string, unknown>)[] = [];
</script>

<section>
  <header style="display:flex;align-items:center;gap:10px">
    <h2 style="font-size:1rem;margin:0 0 8px">timeline</h2>
    {#if badge}<Badge label={badge.label} tone={badge.tone} age_s={badge.age_s} />{/if}
  </header>
  {#if rows.length === 0}
    <p class="empty">no entries</p>
  {:else}
    <ul class="tl">
      {#each rows as row}
        {#if row.kind === "gap"}
          <li class="gap">— gap {row.seconds}s ({row.from} → {row.to}){row.open ? " (open)" : ""} —</li>
        {:else}
          <li><span class="at">{row.at}</span> <span class="type">{row.type ?? row.kind}</span></li>
        {/if}
      {/each}
    </ul>
  {/if}
</section>

<style>
  .tl { list-style: none; margin: 0; padding: 0; font-size: 0.85rem; }
  .tl li { padding: 2px 0; }
  .at { color: #9ca3af; font-family: monospace; margin-right: 8px; }
  .type { font-weight: 600; }
  .gap { color: #f59e0b; font-style: italic; }
  .empty { color: #9ca3af; }
</style>