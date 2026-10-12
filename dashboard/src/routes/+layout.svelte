<script lang="ts">
  import ModeBanner from "$lib/components/ModeBanner.svelte";
  import { getHealth, modeBanner } from "$lib/api";
  import { onMount } from "svelte";
  import type { Health } from "$lib/types";

  export let data: { result: { ok: boolean; data?: Health; at?: string; ageMs?: number } | null };

  const routes = [
    ["/", "overview"], ["/signals", "signals"], ["/watches", "watches"], ["/zones", "zones"],
    ["/events", "events"], ["/analysis", "analysis"], ["/approvals", "approvals"],
    ["/orders", "orders"], ["/failover", "failover"], ["/logs", "logs"], ["/strategy", "strategy"],
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
</script>

<nav>
  {#each routes as [href, label]}<a href={href}>{label}</a>{/each}
</nav>

<ModeBanner banner={banner} />

<main>
  <slot />
</main>

<style>
  nav { display: flex; flex-wrap: wrap; gap: 10px; padding: 10px 14px; border-bottom: 1px solid #262b36; }
  nav a { color: #9ca3af; text-decoration: none; font-size: 0.9rem; }
  nav a:hover { color: #e6e9ef; }
  main { padding: 14px; max-width: 1100px; }
</style>