<script lang="ts">
  import { onMount } from "svelte";
  import { Button } from "$lib/components/ui/button";
  import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "$lib/components/ui/card";
  import { Input } from "$lib/components/ui/input";
  import { Textarea } from "$lib/components/ui/textarea";
  import { Badge } from "$lib/components/ui/badge";
  import { postGenerateStrategy, getStrategyDrafts, getStrategies } from "$lib/api";
  import type { StrategyDraft, StrategyVersion } from "$lib/types";
  import { groups, saveGroup, deleteGroup, toggleMember, type GroupJob } from "$lib/groups";
  import { catalogFromDrafts, entryKey, PINNED_REGISTRY, type LibraryEntry } from "$lib/library";
  import { getSymbols, type SymbolsData } from "$lib/symbols";
  import { setups, touchSetup } from "$lib/setups";
  import Prism from "prismjs";
  import "prismjs/components/prism-go";
  let tab: "library" | "groups" | "drafts" | "limits" = "groups";
  let description = "";
  let strategy_id = "";
  let version = "0.1.0";
  let loading = false;
  let error: string | null = null;
  let result: { id: string; code: string; status: string } | null = null;
  let drafts: StrategyDraft[] = [];
  let versions: StrategyVersion[] = [];
  let symbols: SymbolsData | null = null;
  let catalog: LibraryEntry[] = $derived(catalogFromDrafts(drafts));
  let gname = "";
  let gjob: GroupJob = "entry";
  let picked: Record<string, boolean> = $state({});
  let linkSymbol = "";
  let linkSearch = "";
  let pickedList = $derived(catalog.filter((e) => picked[entryKey(e.id, e.version)]));
  let symList: string[] = $derived(((symbols as SymbolsData | null)?.symbols ?? []).filter((s: string) => !linkSearch.trim() || s.includes(linkSearch.trim().toUpperCase())).slice(0, 30));
  onMount(async () => {
    const d = await getStrategyDrafts();
    if (d.ok) drafts = d.data.drafts;
    const v = await getStrategies();
    if (v.ok) versions = v.data.versions;
    const s = await getSymbols();
    if (s.ok) symbols = s.data;
    Prism.highlightAll();
  });
  async function handleSubmit() {
    if (!description.trim() || !strategy_id.trim()) return;
    loading = true; error = null; result = null;
    const res = await postGenerateStrategy({ description, strategy_id, version });
    loading = false;
    if (!res.ok) { error = res.error; return; }
    result = res.data;
    drafts = [res.data as StrategyDraft, ...drafts];
    setTimeout(() => Prism.highlightAll(), 0);
  }
  function handleSaveGroup() {
    if (!gname.trim()) {
      return alert('لطفاً نام گروهی وارد کنید');
    }
    if (pickedList.length === 0) {
      return alert('حداقل یک استراتژی را تیک بزنید');
    }
    saveGroup({ name: gname.trim(), members: pickedList.map((e) => ({ id: e.id, version: e.version })), job: gjob, createdAt: new Date().toISOString() });
    gname = ""; picked = {};
  }
  function handleLink(groupName: string) {
    const s = linkSymbol.trim().toUpperCase();
    if (!s) return;
    touchSetup(s, { groups: [...new Set([...($setups[s]?.groups ?? []), groupName])] });
    linkSymbol = "";
  }
</script>


<div class="container mx-auto p-6 max-w-6xl">
  <h1 class="text-3xl font-bold mb-2">strategy factory</h1>
  <p class="text-sm text-muted-foreground mb-6">one file per strategy — groups bundle N strategies into one advisory output</p>
  <div class="flex gap-2 mb-6">
    <Button variant={tab === "library" ? "default" : "outline"} onclick={() => (tab = "library")}>library</Button>
    <Button variant={tab === "groups" ? "default" : "outline"} onclick={() => (tab = "groups")}>groups</Button>
    <Button variant={tab === "drafts" ? "default" : "outline"} onclick={() => (tab = "drafts")}>drafts ({drafts.length})</Button>
    <Button variant={tab === "limits" ? "default" : "outline"} onclick={() => (tab = "limits")}>limits</Button>
  </div>
  {#if tab === "library"}
    <div class="grid gap-4 md:grid-cols-2">
      {#each PINNED_REGISTRY as p}
        <Card>
          <CardHeader><CardTitle class="font-mono">{p.id}@{p.version}</CardTitle><CardDescription>{p.name} — {p.blurb}</CardDescription></CardHeader>
          <CardContent><Badge variant="outline">pinned wasm</Badge></CardContent>
        </Card>
      {/each}
    </div>
    <Card class="mt-6">
      <CardHeader><CardTitle>generate new strategy</CardTitle><CardDescription>AI codegen — review-only draft, nothing executes</CardDescription></CardHeader>
      <CardContent class="space-y-4">
        <Textarea bind:value={description} rows={4} placeholder="e.g. RSI divergence: LONG on bullish divergence..." />
        <div class="grid grid-cols-2 gap-4">
          <Input bind:value={strategy_id} placeholder="strategy id" />
          <Input bind:value={version} placeholder="0.1.0" />
        </div>
        <Button onclick={handleSubmit} disabled={loading || !description.trim() || !strategy_id.trim()} class="w-full">{loading ? "Generating..." : "Generate"}</Button>
        {#if error}<div class="text-sm text-destructive">{error}</div>{/if}
        {#if result}<pre class="bg-muted p-4 rounded-md overflow-x-auto text-xs"><code class="language-go">{result.code}</code></pre>{/if}
      </CardContent>
    </Card>
  {:else if tab === "groups"}
    <Card>
      <CardHeader><CardTitle>new group</CardTitle><CardDescription>tick strategies from the library — dupes auto-blocked, drafts labelled</CardDescription></CardHeader>
      <CardContent class="space-y-3">
        <div class="grid grid-cols-2 gap-3">
          <Input bind:value={gname} placeholder="group name (e.g. rsi-div-block)" />
          <select bind:value={gjob} class="border rounded px-2 py-1 text-sm bg-background">
            <option value="entry">entry</option><option value="confirmation">confirmation</option><option value="exit-scan">exit-scan</option>
          </select>
        </div>
        <div class="lib-pick">
          {#each catalog as e}
            {@const k = entryKey(e.id, e.version)}
            <label class="pick-row">
              <input type="checkbox" bind:checked={picked[k]} />
              <span class="font-mono">{e.label}</span>
              <Badge variant={e.kind === "pinned" ? "outline" : "default"}>{e.kind}</Badge>
              <span class="text-xs text-muted-foreground">{e.blurb}</span>
            </label>
          {/each}
        </div>
        <div class="text-sm">picked ({pickedList.length}): {pickedList.map((e) => e.label).join(", ") || "—"}</div>
        <Button onclick={handleSaveGroup} disabled={!gname.trim() || pickedList.length === 0} class="w-full">save group</Button>
      </CardContent>
    </Card>
    <div class="grid gap-4 md:grid-cols-2 mt-6">
      {#each Object.values($groups) as g}
        <Card>
          <CardHeader><CardTitle class="font-mono">{g.name}</CardTitle><CardDescription><Badge variant="outline">advisory-group</Badge> job: {g.job} — {g.members.length} members</CardDescription></CardHeader>
          <CardContent class="space-y-1">
            {#each g.members as m}<div class="text-sm font-mono">{m.id}@{m.version ?? "latest"}</div>{/each}
            <div class="mt-3 space-y-2">
              <Input bind:value={linkSearch} placeholder="search venue symbols..." />
              <div class="lib-pick small">
                {#each symList as s}
                  <button class="pick-row as-btn" on:click={() => { linkSymbol = s; handleLink(g.name); }}>
                    <span class="font-mono">{s}</span>
                    {#if ($setups[s]?.groups ?? []).includes(g.name)}<Badge>linked</Badge>{/if}
                  </button>
                {/each}
              </div>
              <Button size="sm" variant="destructive" onclick={() => deleteGroup(g.name)}>delete group</Button>
            </div>
          </CardContent>
        </Card>
      {/each}
    </div>
    {#if Object.keys($groups).length === 0}<p class="text-sm text-muted-foreground mt-4">no groups yet — tick library strategies above</p>{/if}
  {:else if tab === "drafts"}
    <Card>
      <CardHeader><CardTitle>recent drafts</CardTitle><CardDescription>review-only — nothing executes until built + pinned</CardDescription></CardHeader>
      <CardContent class="space-y-3">
        {#each drafts as draft}
          <div class="border rounded p-3">
            <div class="flex items-center gap-2 mb-1">
              <span class="font-mono font-semibold">{draft.strategy_id}</span>
              <Badge variant="outline">{draft.version}</Badge>
              <Badge>{draft.status}</Badge>
            </div>
            <p class="text-sm text-muted-foreground line-clamp-2">{draft.prompt}</p>
          </div>
        {/each}
        {#if drafts.length === 0}<p class="text-sm text-muted-foreground">no drafts yet</p>{/if}
      </CardContent>
    </Card>
  {:else if tab === "limits"}
    <Card>
      <CardHeader><CardTitle>risk limits (read-only)</CardTitle><CardDescription>active version pins every gate — changes are admin-only in Workers</CardDescription></CardHeader>
      <CardContent class="space-y-3">
        {#each versions as v}
          <div class="border rounded p-3 text-sm">
            <div class="font-mono font-semibold">{v.version} <span class="text-muted-foreground">by {v.activated_by} · {v.at}</span></div>
            <pre class="bg-muted p-2 rounded mt-2 text-xs overflow-x-auto">{v.config_json}</pre>
          </div>
        {/each}
        {#if versions.length === 0}<p class="text-sm text-muted-foreground">no versions</p>{/if}
      </CardContent>
    </Card>
  {/if}
</div>

<style>
  .lib-pick {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 260px;
    overflow-y: auto;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 8px;
  }
  .lib-pick.small { max-height: 160px; }
  .pick-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.85rem;
  }
  .pick-row:hover { background: #161b22; }
  .pick-row.as-btn {
    width: 100%;
    background: none;
    border: none;
    color: #e6e9ef;
    text-align: left;
  }
</style>
