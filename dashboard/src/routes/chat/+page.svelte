<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { Button } from "$lib/components/ui/button";
  import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "$lib/components/ui/card";
  import { Textarea } from "$lib/components/ui/textarea";
  import { Badge } from "$lib/components/ui/badge";
  import {
    streamChat,
    postDraft,
    chatServiceUp,
    postChatCreate,
    getChatSession,
    deleteChatSession,
    postChatPrinciples,
    chatSocket,
    downscaleImage,
    MAX_IMAGE_EDGE,
    MAX_IMAGES_PER_TURN,
    type ChartAttachment,
    type ChatOutboundMessage,
  } from "$lib/api";
  import { page } from "$app/stores";
  import { setups, chatSessionKey, touchSetup } from "$lib/setups";
  import { validateSymbolInput } from "$lib/symbols";
  import Prism from "prismjs";
  import "prismjs/components/prism-go";
  import StalkSetup from "$lib/components/StalkSetup.svelte";
  import { extractSetupProposals } from "$lib/stalk";

  type Message = { id?: string; role: "user" | "assistant"; content: string; timestamp: string; images?: string[] };
  type CodeBlock = { language: string; code: string };
  type WsEvent = { type: string; text?: string; error?: string; codeBlocks?: CodeBlock[]; messageId?: string };

  let messages: Message[] = [];
  let input = "";
  let loading = false;
  let error: string | null = null;
  let principles = "";
  let principlesOpen = false;
  // Chart attachments for the next turn (ADR-010, multi): downscaled
  // client-side, then carried as one image_url content part each. The per-turn
  // cap mirrors the Go boundary (maxImagesPerTurn).
  let attachments: ChartAttachment[] = [];
  let attachBusy = false;
  let fileInput: HTMLInputElement | undefined;
  // The turn id whose reply is on screen — saved with a draft so the code can
  // be traced back to the chart it came from.
  let lastTurnId = "";

  // WS mode: the chat routes inside go-watcher. REST mode: Worker POST fallback.
  let mode: "ws" | "rest" = "rest";
  let sessionId = "";
  // The room symbol (from ?symbol=) — component-level so every turn can declare
  // its ROOM/SETUP context, not just the loader.
  let roomSymbol = "";
  let live = ""; // streamed assistant text, committed on "done"
  let ws: WebSocket | null = null;
  let wsState: "connecting" | "open" | "closed" = "connecting";
  let intentionalClose = false;
  let reconnects = 0;

  onMount(async () => {
    // Per-symbol rooms: /chat?symbol=BTCUSDT reuses that room's session, so
    // each coin keeps its own conversation. No param = legacy global session.
    roomSymbol = validateSymbolInput($page.url.searchParams.get("symbol") ?? "") ?? "";
    const sessionKey = roomSymbol ? chatSessionKey(roomSymbol) : "chat_session_id";
    const msgKey = roomSymbol ? `chat_messages_${roomSymbol}` : "chat_messages";
    const principlesKey = roomSymbol ? `chat_principles_${roomSymbol}` : "chat_principles";
    const savedPrinciples = localStorage.getItem(principlesKey);
    if (savedPrinciples) principles = savedPrinciples;
    if (await chatServiceUp()) {
      mode = "ws";
      sessionId = localStorage.getItem(sessionKey) ?? "";
      if (sessionId) {
        const res = await getChatSession(sessionId);
        if (res.ok) {
          messages = res.data.messages.map((m) => ({
            id: m.id,
            role: m.role as "user" | "assistant",
            content: m.content,
            timestamp: m.timestamp,
            images: (m.attachments ?? []).map((a) => a.dataUrl).filter((u): u is string => !!u),
          }));
          if (res.data.principles) principles = res.data.principles;
        } else {
          sessionId = ""; // stale id (Redis TTL) -> fresh session
        }
      }
      if (!sessionId) {
        const res = await postChatCreate(principles);
        if (res.ok) {
          sessionId = res.data.id;
          localStorage.setItem(sessionKey, sessionId);
          if (roomSymbol) touchSetup(roomSymbol, { chatSession: sessionId });
        } else {
          mode = "rest"; // the probe answered but create failed -> fallback
        }
      } else if (roomSymbol) {
        touchSetup(roomSymbol, { chatSession: sessionId });
      }
      if (mode === "ws") openSocket();
    }
    if (mode === "rest") {
      const saved = localStorage.getItem(msgKey);
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
        if (msg.messageId) lastTurnId = msg.messageId;
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
          persistLocal();
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
      persistLocal();
    }
  }

  /** The client owns the turn id (ADR-010): Go stores it in Redis and the Worker
   *  writes it to D1, so a saved draft can point back at its chart. */
  function newTurnId(): string {
    try {
      return crypto.randomUUID();
    } catch {
      return `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    }
  }

  /** Charts are large — keep only the text transcript in localStorage. */
  function persistLocal() {
    localStorage.setItem(
      "chat_messages",
      JSON.stringify(messages.map((m) => ({ id: m.id, role: m.role, content: m.content, timestamp: m.timestamp }))),
    );
  }

  /** Downscale pasted/dropped charts and APPEND them to the pending batch.
   *  The cap is client-enforced with the same number the Go boundary enforces,
   *  so the trader sees the limit before the wire rejects the turn. */
  async function attachFiles(files: (File | Blob | null | undefined)[]) {
    const usable = files.filter(Boolean) as (File | Blob)[];
    if (!usable.length) return;
    attachBusy = true;
    error = null;
    const imgs: ChartAttachment[] = [];
    for (const file of usable) {
      if (attachments.length + imgs.length >= MAX_IMAGES_PER_TURN) break;
      const img = await downscaleImage(file);
      if (img) imgs.push(img);
    }
    attachBusy = false;
    if (!imgs.length) {
      error = "Could not read that image (try a PNG or JPEG screenshot).";
      return;
    }
    attachments = [...attachments, ...imgs];
    if (usable.length > imgs.length) {
      error = `max ${MAX_IMAGES_PER_TURN} images per message — the rest were dropped`;
    }
  }
  async function attachFile(file: File | Blob | null | undefined) {
    return attachFiles([file]);
  }

  /** Drag & drop the same way as paste/file-picker: append, cap, downscale. */
  function onDrop(e: DragEvent) {
    const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();
    void attachFiles(files);
  }

  function onPaste(e: ClipboardEvent) {
    const files = [...(e.clipboardData?.items ?? [])]
      .filter((i) => i.type.startsWith("image/"))
      .map((i) => i.getAsFile())
      .filter(Boolean) as File[];
    if (files.length) {
      e.preventDefault();
      void attachFiles(files);
    }
  }

  /** roomContext — the dashboard's ROOM/SETUP block for this turn. Setup rooms
   *  (linked strategies/groups/analyses) live in localStorage, so only this
   *  client can declare them; the Go chat service and the Worker REST fallback
   *  both inject it as a labelled DATA system turn (never an instruction).
   *  Omitted entirely when the room has no selection yet. */
  function roomContext(): string {
    if (!roomSymbol) return "";
    const room = $setups[roomSymbol];
    const strategies = (room?.strategies ?? []).map((s) => `${s.id}@${s.version ?? "latest"}`);
    const groups = room?.groups ?? [];
    const analyzes = (room?.analyzes ?? []).slice(-3);
    if (!strategies.length && !groups.length && !analyzes.length) return "";
    return JSON.stringify({ symbol: roomSymbol, strategies, groups, recent_analyze_ids: analyzes });
  }

  async function handleSend() {
    const imgs = attachments;
    const text = input.trim() || (imgs.length ? (imgs.length === 1 ? "Analyze the attached chart." : `Analyze the ${imgs.length} attached charts.`) : "");
    if ((!text && !imgs.length) || loading) return;
    loading = true;
    error = null;
    const turnId = newTurnId();
    const userMsg: Message = {
      id: turnId,
      role: "user",
      content: text,
      timestamp: new Date().toISOString(),
      images: imgs.map((i) => i.dataUrl),
    };
    messages = [...messages, userMsg];
    input = "";
    attachments = [];

    if (mode === "ws" && ws && ws.readyState === WebSocket.OPEN) {
      live = "";
      ws.send(
        JSON.stringify({
          type: "message",
          id: turnId,
          content: text,
          ...(imgs.length
            ? {
                images: imgs.map((i) => ({ mediaType: i.mediaType, dataUrl: i.dataUrl, detail: "low" })),
                // back-compat: a server that predates the multi envelope still
                // sees (and analyzes) the FIRST chart of the batch
                image: { mediaType: imgs[0].mediaType, dataUrl: imgs[0].dataUrl, detail: "low" },
              }
            : {}),
          ...(roomContext() ? { context: roomContext() } : {}),
        }),
      );
      return; // the done event completes the turn
    }
    if (mode === "ws") {
      error = "Chat socket is not connected - retrying...";
      loading = false;
      return;
    }

    // REST path (Worker fallback). Every attached chart rides the newest user
    // turn as its own image_url content part — and the turn MUST stream
    // (chat:stream): a vision generation runs ~60s, past the single-shot
    // response wall-clock, so the non-stream POST dies mid-request (the browser
    // saw an opaque 400). Deltas render into `live` exactly like the WS path,
    // then commit on end.
    const outbound: ChatOutboundMessage[] = messages.map((m) =>
      m.id === turnId && imgs.length
        ? {
            id: m.id,
            role: m.role,
            content: [
              { type: "text", text: m.content },
              ...imgs.map((i) => ({ type: "image_url" as const, image_url: { url: i.dataUrl, detail: "low" } })),
            ],
          }
        : { id: m.id, role: m.role, content: m.content },
    );
    live = "";
    const res = await streamChat(
      { session_id: sessionId || undefined, messages: outbound, principles, ...(roomContext() ? { context: roomContext() } : {}) },
      (t) => { live += t; },
    );
    const streamed = live;
    live = "";
    loading = false;
    if (!res.ok) {
      error = res.error;
      return;
    }
    lastTurnId = turnId;
    messages = [...messages, { role: "assistant", content: res.data.response || streamed, timestamp: new Date().toISOString() }];
    saveToStorage();
    setTimeout(() => Prism.highlightAll(), 0);
  }

  async function handleSaveDraft(codeBlock: CodeBlock) {
    const strategy_id = prompt("Strategy ID (e.g., sma-cross):");
    if (!strategy_id) return;
    const version = prompt("Version (e.g., 0.1.0):") || "0.1.0";
    const res = await postDraft({ strategy_id, version, code: codeBlock.code, prompt: messages[0]?.content ?? "", message_id: lastTurnId || undefined });
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
  {#if validateSymbolInput($page.url.searchParams.get("symbol") ?? "")}
    <div class="mb-4 flex items-center gap-3 text-sm">
      <a href="/setups/{validateSymbolInput($page.url.searchParams.get('symbol') ?? '')}" class="text-blue-400 hover:underline">← {validateSymbolInput($page.url.searchParams.get("symbol") ?? "")} room</a>
      <span class="text-muted-foreground">this conversation is scoped to that coin</span>
    </div>
  {/if}
  <div class="flex items-center justify-between mb-6">
    <div class="flex items-center gap-3">
      <h1 class="text-3xl font-bold">Strategy Chat{validateSymbolInput($page.url.searchParams.get("symbol") ?? "") ? ` — ${validateSymbolInput($page.url.searchParams.get("symbol") ?? "")}` : ""}</h1>
      {#if mode === "ws"}
        {#if wsState === "open"}
          <Badge variant="outline" class="border-emerald-500 text-emerald-500">live - session {sessionId}</Badge>
        {:else if wsState === "connecting"}
          <Badge variant="outline">connecting...</Badge>
        {:else}
          <Badge variant="outline" class="border-amber-500 text-amber-500">reconnecting...</Badge>
        {/if}
      {:else}
        <Badge variant="outline" title="chat routes (go-watcher :8080) unavailable - using the Worker REST endpoint">REST fallback</Badge>
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
                {#if (msg.images ?? []).length}
                  <div class="mb-2 flex flex-wrap gap-2">
                    {#each msg.images as im}
                      <img src={im} alt="attached chart" class="max-h-48 rounded border border-black/10" />
                    {/each}
                  </div>
                {/if}
                <div class="text-sm whitespace-pre-wrap">{msg.content}</div>
                {#if msg.role === "assistant"}
                  {#each extractSetupProposals(msg.content) as sp}
                    {#if sp.proposal}
                      <StalkSetup proposal={{ ...sp.proposal, chat_session: sessionId || undefined, message_id: msg.id }} contextLabel="from chat turn" />
                    {:else}
                      <StalkSetup proposal={null} invalidReason={sp.error ?? "invalid proposal"} />
                    {/if}
                  {/each}
                {/if}
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
    <CardContent
      class="p-4"
      role="region"
      aria-label="composer - drop charts here"
      ondragover={(e) => e.preventDefault()}
      ondrop={onDrop}
    >
      {#if attachments.length}
        <div class="mb-2 flex flex-wrap items-center gap-3">
          {#each attachments as a, i}
            <div class="flex items-center gap-2">
              <img src={a.dataUrl} alt="chart {i + 1} to send" class="h-16 rounded border border-border" />
              <button
                type="button"
                class="text-xs text-muted-foreground hover:text-destructive"
                onclick={() => (attachments = attachments.filter((_, j) => j !== i))}
                title="remove this chart"
              >×</button>
            </div>
          {/each}
          <span class="text-xs text-muted-foreground">
            {attachments.length}/{MAX_IMAGES_PER_TURN} charts · {attachments[0]?.mediaType} · downscaled to ≤{MAX_IMAGE_EDGE}px
          </span>
        </div>
      {/if}
      <div class="flex gap-2">
        <input
          bind:this={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          class="hidden"
          onchange={(e) => {
            const el = e.currentTarget as HTMLInputElement;
            void attachFiles([...(el.files ?? [])]);
            el.value = "";
          }}
        />
        <Button variant="outline" onclick={() => fileInput?.click()} disabled={attachBusy || loading || attachments.length >= MAX_IMAGES_PER_TURN} class="self-end" title="Attach chart screenshots — you can pick several (or paste into the box)">
          {attachBusy ? "..." : `Chart${attachments.length ? ` (${attachments.length}/${MAX_IMAGES_PER_TURN})` : ""}`}
        </Button>
        <Textarea bind:value={input} placeholder="Describe your strategy... or paste: setup BTCUSDT LONG @ trigger / invalidation (I'll shape it into a stalkable proposal)" rows={3} onpaste={onPaste} onkeydown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), handleSend())} />
        <Button onclick={handleSend} disabled={loading || (!input.trim() && !attachments.length)} class="self-end">{loading ? "Sending..." : "Send"}</Button>
      </div>
      {#if error}<div class="mt-2 p-2 bg-destructive/10 border border-destructive rounded text-destructive text-sm">{error}</div>{/if}
    </CardContent>
  </Card>
</div>

