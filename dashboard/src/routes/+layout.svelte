<script lang="ts">
  import "../app.css";
  import ModeBanner from "$lib/components/ModeBanner.svelte";
  import { getHealth, modeBanner } from "$lib/api";
  import { onMount } from "svelte";
  import type { Health } from "$lib/types";
  import { page } from "$app/stores";

  export let data: { result: { ok: boolean; data?: Health; at?: string; ageMs?: number } | null };

  const routes = [
    ["/", "overview"], ["/setups", "setups"], ["/strategies", "strategies"],
    ["/approvals", "approvals"], ["/logs", "logs"],
  ];

  let health: Health | null = data?.result?.ok ? (data.result.data as Health) : null;
  let error: string | null = data?.result?.ok ? null : (data?.result as any)?.error ?? null;

  async function refresh() {
    const r = await getHealth();
    if (r.ok) { health = r.data; error = null; } else { error = r.error; }
  }
  onMount(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  });

  $: banner = health ? modeBanner(health.mode, health.reasons) : modeBanner("D1_DOWN", [error ?? "health unreadable"]);
  $: currentPath = $page.url.pathname;
</script>

<div class="app">
  <nav>
    {#each routes as [href, label]}
      <a href={href} class:active={currentPath === href}>{label}</a>
    {/each}
  </nav>

  <ModeBanner banner={banner} />

  {#if health?.execution_venue}
    <div class="venue {health.execution_venue === 'paper-sim' ? 'paper' : 'injected'}" role="status">
      execution venue: <strong>{health.execution_venue}</strong>
      {#if health.execution_venue === "paper-sim"}
        — order intents are filled by the PAPER simulator, so every FILLED row and position is a simulated fill (D-06: Toobit has no testnet; no live-order path exists)
      {:else}
        — a non-default exchange adapter is injected (drill/test)
      {/if}
    </div>
  {/if}

  <main>
    <slot />
  </main>
</div>

<style>
  .app {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  nav {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 10px 16px;
    border-bottom: 1px solid #1e2330;
    background: #0d1117;
    position: sticky;
    top: 0;
    z-index: 10;
  }

  nav a {
    color: #8b949e;
    text-decoration: none;
    font-size: 0.85rem;
    font-weight: 500;
    padding: 6px 12px;
    border-radius: 6px;
    transition: color 0.15s, background 0.15s;
    white-space: nowrap;
  }

  nav a:hover {
    color: #e6e9ef;
    background: #161b22;
  }

  nav a.active {
    color: #e6e9ef;
    background: #1f2937;
  }

  main {
    flex: 1;
    padding: 20px;
    max-width: 1200px;
    width: 100%;
    margin: 0 auto;
  }

  .venue {
    max-width: 1160px;
    margin: 10px auto 0;
    padding: 8px 14px;
    border-radius: 8px;
    font-size: 0.78rem;
    line-height: 1.4;
  }

  .venue.paper {
    border: 1px solid #6b7280;
    background: #161b22;
    color: #c9d1d9;
  }

  .venue.injected {
    border: 1px solid #eab308;
    background: #2a220d;
    color: #eab308;
  }
</style>