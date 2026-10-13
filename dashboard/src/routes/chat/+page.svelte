<script lang="ts">
  import { onMount } from "svelte";
  import { Button } from "$lib/components/ui/button";
  import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "$lib/components/ui/card";
  import { Textarea } from "$lib/components/ui/textarea";
  import { Badge } from "$lib/components/ui/badge";
  import { postChat, postDraft } from "$lib/api";
  import Prism from "prismjs";
  import "prismjs/components/prism-go";

  type Message = { role: "user" | "assistant"; content: string; timestamp: string };
  type CodeBlock = { language: string; code: string };

  let messages: Message[] = [];
  let input = "";
  let loading = false;
  let error: string | null = null;
  let principles = "";
  let principlesOpen = false;

  onMount(() => {
    const saved = localStorage.getItem("chat_messages");
    if (saved) messages = JSON.parse(saved);
    const savedPrinciples = localStorage.getItem("chat_principles");
    if (savedPrinciples) principles = savedPrinciples;
    setTimeout(() => Prism.highlightAll(), 0);
  });

  function saveToStorage() {
    localStorage.setItem("chat_messages", JSON.stringify(messages));
    localStorage.setItem("chat_principles", principles);
  }

  async function handleSend() {
    if (!input.trim() || loading) return;
    loading = true;
    error = null;
    const userMsg: Message = { role: "user", content: input.trim(), timestamp: new Date().toISOString() };
    messages = [...messages, userMsg];
    input = "";
    saveToStorage();

    const res = await postChat({ messages: messages.map((m) => ({ role: m.role, content: m.content })), principles });
    loading = false;

    if (!res.ok) {
      error = res.error;
      return;
    }

    const aiMsg: Message = { role: "assistant", content: res.data.response, timestamp: new Date().toISOString() };
    messages = [...messages, aiMsg];
    saveToStorage();
    setTimeout(() => Prism.highlightAll(), 0);
  }

  async function handleSaveDraft(codeBlock: CodeBlock) {
    const strategy_id = prompt("Strategy ID (e.g., sma-cross):");
    if (!strategy_id) return;
    const version = prompt("Version (e.g., 0.1.0):") || "0.1.0";
    const res = await postDraft({ strategy_id, version, code: codeBlock.code, prompt: messages[0]?.content ?? "" });
    if (res.ok) {
      alert(`Draft saved: ${res.data.id}`);
    } else {
      alert(`Failed: ${res.error}`);
    }
  }

  function clearChat() {
    if (confirm("Clear all messages?")) {
      messages = [];
      localStorage.removeItem("chat_messages");
    }
  }

  function extractCodeBlocks(content: string): CodeBlock[] {
    const blocks: CodeBlock[] = [];
    const re = /```(\w+)?\s*\n([\s\S]*?)```/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      blocks.push({ language: m[1] ?? "text", code: m[2].trim() });
    }
    return blocks;
  }
</script>

<div class="container mx-auto p-6 max-w-6xl">
  <div class="flex items-center justify-between mb-6">
    <h1 class="text-3xl font-bold">Strategy Chat</h1>
    <div class="flex gap-2">
      <Button variant="outline" on:click={() => (principlesOpen = !principlesOpen)}>
        {principlesOpen ? "Hide" : "Show"} Principles
      </Button>
      <Button variant="destructive" on:click={clearChat}>Clear</Button>
    </div>
  </div>

  {#if principlesOpen}
    <Card class="mb-6">
      <CardHeader>
        <CardTitle>Trading Principles</CardTitle>
        <CardDescription>These will be injected as system context for every message</CardDescription>
      </CardHeader>
      <CardContent>
        <Textarea
          bind:value={principles}
          on:change={saveToStorage}
          placeholder="e.g., Max risk 2% per trade, prefer trend-following, avoid choppy markets..."
          rows={4}
        />
      </CardContent>
    </Card>
  {/if}

  <div class="grid gap-6 md:grid-cols-[1fr_400px]">
    <Card>
      <CardHeader><CardTitle>Conversation</CardTitle></CardHeader>
      <CardContent class="space-y-4 max-h-[600px] overflow-y-auto">
        {#if messages.length === 0}
          <div class="text-muted-foreground text-sm text-center py-12">Start a conversation about your trading strategy</div>
        {:else}
          {#each messages as msg}
            <div class="flex {msg.role === 'user' ? 'justify-end' : 'justify-start'}">
              <div class="max-w-[80%] {msg.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted'} rounded-lg p-3">
                <div class="text-sm whitespace-pre-wrap">{msg.content}</div>
                <div class="text-xs opacity-70 mt-1">{new Date(msg.timestamp).toLocaleTimeString()}</div>
              </div>
            </div>
          {/each}
          {#if loading}<div class="flex justify-start"><div class="bg-muted rounded-lg p-3"><div class="text-sm">Thinking...</div></div></div>{/if}
        {/if}
      </CardContent>
    </Card>

    <Card>
      <CardHeader><CardTitle>Extracted Code</CardTitle><CardDescription>Click "Save as draft" to store</CardDescription></CardHeader>
      <CardContent class="space-y-3 max-h-[600px] overflow-y-auto">
        {#each messages.filter((m) => m.role === "assistant") as msg}
          {#each extractCodeBlocks(msg.content) as block}
            <Card class="p-3">
              <div class="flex items-center justify-between mb-2">
                <Badge variant="outline">{block.language}</Badge>
                <Button size="sm" on:click={() => handleSaveDraft(block)}>Save as draft</Button>
              </div>
              <pre class="bg-muted p-2 rounded text-xs overflow-x-auto"><code class="language-{block.language}">{block.code}</code></pre>
            </Card>
          {/each}
        {/each}
        {#if messages.filter((m) => m.role === "assistant").every((m) => extractCodeBlocks(m.content).length === 0)}
          <div class="text-muted-foreground text-sm text-center py-8">Code blocks from AI responses will appear here</div>
        {/if}
      </CardContent>
    </Card>
  </div>

  <Card class="mt-6">
    <CardContent class="p-4">
      <div class="flex gap-2">
        <Textarea bind:value={input} placeholder="Describe your strategy or ask a question..." rows={3} on:keydown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()} />
        <Button on:click={handleSend} disabled={loading || !input.trim()} class="self-end">{loading ? "Sending..." : "Send"}</Button>
      </div>
      {#if error}<div class="mt-2 p-2 bg-destructive/10 border border-destructive rounded text-destructive text-sm">{error}</div>{/if}
    </CardContent>
  </Card>
</div>