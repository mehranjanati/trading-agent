<script lang="ts">
  // Telegram alert topics (docs/09 §9.3a): which events push to the phone.
  // Advisory-only page — it selects pushes, never an order or approval (D-08).
  import { onMount } from "svelte";
  import { getNotifyPrefs, setNotifyPrefs } from "$lib/api";
  import { TOPIC_LABELS, prefsToMap } from "$lib/alerts-core.mjs";

  let loaded: Record<string, boolean> = {};
  let current: Record<string, boolean> = {};
  let loading = true;
  let saving = false;
  let error: string | null = null;
  let savedAt: string | null = null;

  $: dirty = TOPIC_LABELS.filter(({ topic }) => (current[topic] ?? true) !== (loaded[topic] ?? true));

  onMount(async () => {
    const r = await getNotifyPrefs();
    loading = false;
    if (r.ok) {
      loaded = prefsToMap(r.data.prefs);
      current = { ...loaded };
    } else {
      error = r.error;
    }
  });

  function toggle(topic: string) {
    current = { ...current, [topic]: !(current[topic] ?? true) };
  }

  async function save() {
    saving = true;
    error = null;
    const delta: Record<string, boolean> = {};
    for (const { topic } of dirty) delta[topic] = current[topic] ?? true;
    const res = await setNotifyPrefs(delta);
    saving = false;
    if (!res.ok) {
      error = res.error;
      return;
    }
    loaded = { ...loaded, ...delta };
    savedAt = new Date().toLocaleTimeString();
  }
</script>

<div class="page">
  <h1>🔔 الرت‌های تلگرام</h1>
  <p class="subtitle">کدام رویدادها روی موبایل push شوند — فقط انتخابی است، روی مسیر سفارش اثری ندارد.</p>

  {#if loading}
    <p class="muted">در حال بارگذاری…</p>
  {:else if error && !dirty.length && !savedAt}
    <p class="error">خطا: {error}</p>
  {:else}
    <div class="topics">
      {#each TOPIC_LABELS as { topic, fa }}
        <label class="topic" class:critical={topic === "SAFETY"}>
          <input type="checkbox" checked={current[topic] ?? true} on:change={() => toggle(topic)} />
          <span>{fa}</span>
          <code>{topic}</code>
          {#if topic === "SAFETY"}<em>توصیه: همیشه روشن</em>{/if}
        </label>
      {/each}
    </div>

    {#if error}
      <p class="error">خطا: {error}</p>
    {/if}
    {#if savedAt && !dirty.length}
      <p class="saved">✓ ذخیره شد — {savedAt}</p>
    {/if}

    <button disabled={!dirty.length || saving} on:click={save}>
      {saving ? "در حال ذخیره…" : dirty.length ? `ذخیره (${dirty.length} تغییر)` : "تغییری نیست"}
    </button>
  {/if}
</div>

<style>
  .page { padding: 1.5rem; max-width: 640px; }
  h1 { margin-bottom: 0.25rem; }
  .subtitle { color: #8b949e; margin-bottom: 1.25rem; }
  .topics { display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 1rem; }
  .topic {
    display: flex; align-items: center; gap: 0.6rem;
    padding: 0.6rem 0.75rem; border: 1px solid #30363d; border-radius: 8px;
    cursor: pointer;
  }
  .topic.critical { border-color: #f8514966; }
  .topic span { flex: 1; }
  .topic code { color: #8b949e; font-size: 0.75rem; }
  .topic em { color: #f85149; font-size: 0.75rem; font-style: normal; }
  .muted { color: #8b949e; }
  .error { color: #f85149; }
  .saved { color: #3fb950; }
  button {
    padding: 0.5rem 1.25rem; border-radius: 8px; border: 1px solid #30363d;
    background: #21262d; color: inherit; cursor: pointer;
  }
  button:disabled { opacity: 0.5; cursor: default; }
</style>
