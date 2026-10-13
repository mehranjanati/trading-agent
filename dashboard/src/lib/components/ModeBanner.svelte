<script lang="ts">
  export let banner: { visible: boolean; mode: string; text: string; limitations: string[]; reasons?: string[] } | null = null;
</script>

{#if banner?.visible}
  <div class="banner {banner.mode}" role="alert">
    <div class="banner-header">
      <strong>{banner.text}</strong>
    </div>
    {#if banner.limitations?.length}
      <ul>
        {#each banner.limitations as l}<li>{l}</li>{/each}
      </ul>
    {/if}
    {#if banner.reasons?.length}
      <div class="reasons">cause: {banner.reasons.join("; ")}</div>
    {/if}
  </div>
{/if}

<style>
  .banner {
    padding: 10px 14px;
    border-radius: 8px;
    margin: 0 20px 16px;
    border: 1px solid #f59e0b;
    background: #2a230d;
    max-width: 1160px;
    margin-left: auto;
    margin-right: auto;
  }

  .banner.HALTED {
    border-color: #ef4444;
    background: #2a0d0d;
  }

  .banner.D1_DOWN {
    border-color: #6b7280;
    background: #1a1d24;
  }

  .banner-header {
    font-size: 0.9rem;
    font-weight: 600;
    margin-bottom: 4px;
  }

  .banner ul {
    margin: 4px 0 0 16px;
    padding: 0;
    font-size: 0.82rem;
    color: #d1d5db;
  }

  .banner li {
    margin-bottom: 2px;
  }

  .reasons {
    margin-top: 6px;
    font-size: 0.78rem;
    opacity: 0.75;
    color: #9ca3af;
  }
</style>