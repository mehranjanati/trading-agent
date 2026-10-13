<script lang="ts">
  export let label: string;
  export let tone: string = "grey";
  export let age_s: number | null = null;
</script>

<span class="badge {tone}">
  {label}
  {#if age_s !== null}
    <span class="age">{age_s}s</span>
  {/if}
</span>

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-weight: 600;
    font-size: 0.7rem;
    padding: 2px 8px;
    border-radius: 12px;
    border: 1px solid currentColor;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .age {
    font-weight: 400;
    opacity: 0.7;
    font-size: 0.65rem;
  }

  .green { color: #22c55e; border-color: #22c55e44; background: #22c55e11; }
  .amber { color: #f59e0b; border-color: #f59e0b44; background: #f59e0b11; }
  .grey { color: #9ca3af; border-color: #9ca3af44; background: #9ca3af11; }
  .red { color: #ef4444; border-color: #ef444444; background: #ef444411; }
</style>