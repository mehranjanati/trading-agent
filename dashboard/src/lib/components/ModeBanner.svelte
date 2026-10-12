<script lang="ts">
  export let banner: { visible: boolean; mode: string; text: string; limitations: string[]; reasons?: string[] } | null = null;
</script>

{#if banner?.visible}
  <div class="banner {banner.mode}" role="alert">
    <strong>{banner.text}</strong>
    <ul>
      {#each banner.limitations as l}<li>{l}</li>{/each}
    </ul>
    {#if banner.reasons?.length}
      <div class="reasons">cause: {banner.reasons.join("; ")}</div>
    {/if}
  </div>
{/if}

<style>
  .banner { padding: 8px 12px; border-radius: 6px; margin-bottom: 12px; border: 1px solid #f59e0b; background: #2a230d; }
  .banner.HALTED { border-color: #ef4444; background: #2a0d0d; }
  .banner.D1_DOWN { border-color: #9ca3af; background: #1a1a1a; }
  .banner ul { margin: 4px 0 0 16px; padding: 0; font-size: 0.85rem; }
  .reasons { margin-top: 6px; font-size: 0.8rem; opacity: 0.8; }
</style>