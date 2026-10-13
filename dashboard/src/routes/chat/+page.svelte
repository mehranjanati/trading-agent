<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { Button } from "$lib/components/ui/button";
  import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "$lib/components/ui/card";
  import { Textarea } from "$lib/components/ui/textarea";
  import { Badge } from "$lib/components/ui/badge";
  import {
    postChat,
    postDraft,
    chatServiceUp,
    postChatCreate,
    getChatSession,
    deleteChatSession,
    postChatPrinciples,
    chatSocket,
  } from "$lib/api";
  import Prism from "prismjs";
  import "prismjs/components/prism-go";

  type Message = { role: "user" | "assistant"; content: string; timestamp: string };
  type CodeBlock = { language: string; code: string };
  type WsEvent = { type: string; text?: string; error?: string; codeBlocks?: CodeBlock[] };

  let messages: Message[] = [];
  let input = "";
  let loading = false;
  let error: string | null = null;
  let principles = "";
  let principlesOpen = false;

  // WS mode: chatd (Go + Redis + WebSocket). Rest mode: Worker POST fallback.
  let mode: "ws" | "rest" = "rest";
  let sessionId = "";
  let live = ""; // streamed assistant text, committed on "done"
  let ws: WebSocket | null = null;
  let wsState: "connecting" | "open" | "closed" = "connecting";
  let intentionalClose = false;
  let reconnects = 0;

  onMount(async () => {
    const savedPrinciples = localStorage.getItem("chat_principles");
    if (savedPrinciples) principles = savedPrinciples;
    if (await chatServiceUp()) {
      mode = "ws";
      sessionId = localStorage.getItem("chat_session_id") ?? "";
      if (sessionId) {
        const res = await getChatSession(sessionId);
        if (res.ok) {
          messages = res.data.messages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content, timestamp: m.timestamp }));
          if (res.data.principles) principles = res.data.principles;
        } else {
          sessionId = ""; // stale id (Redis TTL) -> fresh session
        }
      }
      if (!sessionId) {
        const res = await postChatCreate(principles);
        if (res.ok) {
          sessionId = res.data.id;
          localStorage.setItem("chat_session_id", sessionId);
        } else {
          mode = "rest"; // chatd answered the probe but create failed -> fallback
        }
      }
      if (mode === "ws") openSocket();
    }
    if (mode === "rest") {
      const saved = localStorage.getItem("chat_messages");
      if (saved) messages = JSON.parse(saved);
    }
    setTimeout(() => Prism.highlightAll(), 0);
  });

  onDestroy(() => {
    intentionalClose = true;
    ws?.close();
  });

  function openSocket() {
    wsState = "connecting";
    ws = chatSocket(sessionId);
    ws.onopen = () => {
      wsState = "open";
      reconnects = 0;
    };
    ws.onmessage = (ev) => {
      let msg: WsEvent;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === "chunk") {
        live += msg.text ?? "";
      } else if (msg.type === "done") {
        const content = msg.text ?? live;
        messages = [...messages, { role: "assistant", content, timestamp: new Date().toISOString() }];
        live = "";
        loading = false;
        setTimeout(() => Prism.highlightAll(), 0);
      } else if (msg.type === "error") {
        error = msg.error ?? "chat error";
        live = "";
        loading = false;
      }
    };
    ws.onclose = () => {
      wsState = "closed";
      loading = false;
      // Bounded reconnect, then graceful degradation to the REST fallback.
      if (!intentionalClose && mode === "ws") {
        if (reconnects < 3) {
          reconnects++;
          setTimeout(openSocket, 1500 * reconnects);
        } else {
          mode = "rest";
          localStorage.setItem("chat_messages", JSON.stringify(messages));
        }
      }
    };
    ws.onerror = () => {
      /* onclose fires next; the fallback lives there */
    };
  }

  function saveToStorage() {
    localStorage.setItem("chat_principles", principles);
    if (mode === "ws") {
      if (sessionId) void postChatPrinciples(sessionId, principles);
    } else {
      localStorage.setItem("chat_messages", JSON.stringify(messages));
    }
  }

  async function handleSend() {
    if (!input.trim() || loading) return;
    loading = true;
    error = null;
    const userMsg: Message = { role: "user", content: input.trim(), timestamp: new Date().toISOString() };
    messages = [...messages, userMsg];
    input = "";

    if (mode === "ws" && ws && ws.readyState === WebSocket.OPEN) {
      live = "";
      ws.send(JSON.stringify({ type: "message", content: userMsg.content }));
      return; // the done event completes the turn
    }
    if (mode === "ws") {
      error = "Chat socket is not connected - retrying...";
      loading = false;
      return;
    }

    // REST path (Worker fallback): synchronous round-trip.
    const res = await postChat({ messages: messages.map((m) => ({ role: m.role, content: m.content })), principles });
    loading = false;
    if (!res.ok) {
      error = res.error;
      return;
    }
    messages = [...messages, { role: "assistant", content: res.data.response, timestamp: new Date().toISOString() }];
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

  async function clearChat() {
    if (!confirm("Clear all messages?")) return;
    messages = [];
    live = "";
    localStorage.removeItem("chat_messages");
    if (mode === "ws" && sessionId) {
      await deleteChatSession(sessionId);
      localStorage.removeItem("chat_session_id");
      intentionalClose = true;
      ws?.close();
      sessionId = "";
      const res = await postChatCreate(principles);
      if (res.ok) {
        sessionId = res.data.id;
        localStorage.setItem("chat_session_id", sessionId);
        intentionalClose = false;
        openSocket();
      } else {
        mode = "rest";
      }
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
    <div class="flex items-center gap-3">
      <h1 class="text-3xl font-bold">Strategy Chat</h1>
      {#if mode === "ws"}
        {#if wsState === "open"}
          <Badge variant="outline" class="border-emerald-500 text-emerald-500">live - session {sessionId}</Badge>
        {:else if wsState === "connecting"}
          <Badge variant="outline">connecting...</Badge>
        {:else}
          <Badge variant="outline" class="border-amber-500 text-amber-500">reconnecting...</Badge>
        {/if}
      {:else}
        <Badge variant="outline" title="chatd (Go/Redis/WS) unavailable - using the Worker REST endpoint">REST fallback</Badge>
      {/if}
    </div>
    <div class="flex gap-2">
      <Button variant="outline" onclick={() => (principlesOpen = !principlesOpen)}>
        {principlesOpen ? "Hide" : "Show"} Principles
      </Button>
      <Button variant="destructive" onclick={clearChat}>Clear</Button>
    </div>
  </div>

  {#if principlesOpen}
    <Card class="mb-6">
      <CardHeader>
        <CardTitle>Trading Principles</CardTitle>
        <CardDescription>Injected as system context for every message{mode === "ws" ? " and persisted with the session" : ""}</CardDescription>
      </CardHeader>
      <CardContent>
        <Textarea
          bind:value={principles}
          onchange={saveToStorage}
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
        {#if messages.length === 0 && !live}
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
          {#if live}
            <div class="flex justify-start">
              <div class="max-w-[80%] bg-muted rounded-lg p-3">
                <div class="text-sm whitespace-pre-wrap">{live}<span class="animate-pulse">|</span></div>
              </div>
            </div>
          {:else if loading}
            <div class="flex justify-start"><div class="bg-muted rounded-lg p-3"><div class="text-sm">Thinking...</div></div></div>
          {/if}
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
                <Button size="sm" onclick={() => handleSaveDraft(block)}>Save as draft</Button>
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
        <Textarea bind:value={input} placeholder="Describe your strategy or ask a question..." rows={3} onkeydown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), handleSend())} />
        <Button onclick={handleSend} disabled={loading || !input.trim()} class="self-end">{loading ? "Sending..." : "Send"}</Button>
      </div>
      {#if error}<div class="mt-2 p-2 bg-destructive/10 border border-destructive rounded text-destructive text-sm">{error}</div>{/if}
    </CardContent>
  </Card>
</div>

