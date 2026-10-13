<script lang="ts">
  import { onMount } from "svelte";
  import { Button } from "$lib/components/ui/button";
  import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "$lib/components/ui/card";
  import { Input } from "$lib/components/ui/input";
  import { Textarea } from "$lib/components/ui/textarea";
  import { Badge } from "$lib/components/ui/badge";
  import { postGenerateStrategy, getStrategyDrafts } from "$lib/api";
  import type { StrategyDraft } from "$lib/types";
  import Prism from "prismjs";
  import "prismjs/components/prism-go";

  let description = "";
  let strategy_id = "";
  let version = "0.1.0";
  let loading = false;
  let error: string | null = null;
  let result: { id: string; code: string; status: string } | null = null;
  let drafts: StrategyDraft[] = [];

  onMount(async () => {
    const res = await getStrategyDrafts();
    if (res.ok) drafts = res.data.drafts;
    Prism.highlightAll();
  });

  async function handleSubmit() {
    if (!description.trim() || !strategy_id.trim()) return;
    loading = true;
    error = null;
    result = null;
    const res = await postGenerateStrategy({ description, strategy_id, version });
    loading = false;
    if (!res.ok) {
      error = res.error;
      return;
    }
    result = res.data;
    drafts = [res.data as StrategyDraft, ...drafts];
    setTimeout(() => Prism.highlightAll(), 0);
  }
</script>

<div class="container mx-auto p-6 max-w-6xl">
  <h1 class="text-3xl font-bold mb-6">AI Strategy Generator</h1>

  <div class="grid gap-6 md:grid-cols-2">
    <!-- Chat Form -->
    <Card>
      <CardHeader>
        <CardTitle>Generate Strategy</CardTitle>
        <CardDescription>Describe your strategy in natural language</CardDescription>
      </CardHeader>
      <CardContent class="space-y-4">
        <div class="space-y-2">
          <label class="text-sm font-medium">Strategy Description</label>
          <Textarea
            bind:value={description}
            placeholder="e.g., SMA crossover: LONG when 5-period SMA crosses above 20-period SMA, SHORT when below"
            rows={6}
          />
        </div>

        <div class="grid grid-cols-2 gap-4">
          <div class="space-y-2">
            <label class="text-sm font-medium">Strategy ID</label>
            <Input bind:value={strategy_id} placeholder="sma-cross" />
          </div>
          <div class="space-y-2">
            <label class="text-sm font-medium">Version</label>
            <Input bind:value={version} placeholder="0.1.0" />
          </div>
        </div>

        <Button on:click={handleSubmit} disabled={loading || !description.trim() || !strategy_id.trim()} class="w-full">
          {loading ? "Generating..." : "Generate Strategy"}
        </Button>

        {#if error}
          <div class="p-3 bg-destructive/10 border border-destructive rounded-md text-destructive text-sm">
            {error}
          </div>
        {/if}
      </CardContent>
    </Card>

    <!-- Generated Code -->
    <Card>
      <CardHeader>
        <CardTitle>Generated Code</CardTitle>
        {#if result}
          <CardDescription>
            <Badge variant={result.status === "generated" ? "default" : "destructive"}>
              {result.status}
            </Badge>
          </CardDescription>
        {/if}
      </CardHeader>
      <CardContent>
        {#if result}
          <pre class="bg-muted p-4 rounded-md overflow-x-auto"><code class="language-go">{result.code}</code></pre>
        {:else}
          <div class="text-muted-foreground text-sm text-center py-12">
            Generated Go code will appear here
          </div>
        {/if}
      </CardContent>
    </Card>
  </div>

  <!-- Drafts List -->
  <Card class="mt-6">
    <CardHeader>
      <CardTitle>Recent Drafts</CardTitle>
      <CardDescription>AI-generated strategy drafts (review-only)</CardDescription>
    </CardHeader>
    <CardContent>
      {#if drafts.length === 0}
        <div class="text-muted-foreground text-sm text-center py-8">
          No drafts yet. Generate your first strategy above.
        </div>
      {:else}
        <div class="space-y-3">
          {#each drafts as draft}
            <Card class="p-4">
              <div class="flex items-start justify-between gap-4">
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2 mb-1">
                    <span class="font-mono font-semibold">{draft.strategy_id}</span>
                    <Badge variant="outline">{draft.version}</Badge>
                    <Badge variant={draft.status === "generated" ? "default" : "destructive"}>
                      {draft.status}
                    </Badge>
                  </div>
                  <p class="text-sm text-muted-foreground line-clamp-2">{draft.prompt}</p>
                  <p class="text-xs text-muted-foreground mt-1">
                    {new Date(draft.created_at).toLocaleString()} · {draft.model}
                  </p>
                </div>
              </div>
            </Card>
          {/each}
        </div>
      {/if}
    </CardContent>
  </Card>
</div>