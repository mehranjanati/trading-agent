<script lang="ts">
  export let label: string;
  export let tone: string = "grey";
  export let age_s: number | null = null;
</script>

<span class="badge {tone}">{label}{age_s !== null ? ` (${age_s}s)` : ""}</span>

<style>
  .badge { font-weight: 600; font-size: 0.75rem; padding: 1px 6px; border-radius: 4px; border: 1px solid currentColor; }
  .green { color: #22c55e; }
  .amber { color: #f59e0b; }
  .grey { color: #9ca3af; }
  .red { color: #ef4444; }
</style>