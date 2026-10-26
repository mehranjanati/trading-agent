<script lang="ts">
  // ChatWidget — a floating assistant panel on every dashboard page.
  // A second skin over the EXISTING chat service: it reuses the global session
  // (localStorage `chat_session_id`) so a conversation started here continues
  // on /chat and vice versa. Advisory only — it never touches watches, orders,
  // approvals or kill-switch state (D-08).
  import { onMount, onDestroy } from "svelte";
  import {
    streamChat,
    chatServiceUp,
    postChatCreate,
    getChatSession,
    chatSocket,
    type ChatOutboundMessage,
  } from "$lib/api";
  import {
    WIDGET_SESSION_KEY,
    WIDGET_MESSAGES_KEY,
    WIDGET_OPEN_KEY,
    visibleMessages,
    applyWsEvent,
    buildOutbound,
    buildRestOutbound,
    pageContext,
    SETUPS_KEY,
  } from "$lib/chat-widget-core.mjs";

  type Msg = { id?: string; role: "user" | "assistant"; content: string; timestamp: string };

  let open = false;
  let messages: Msg[] = [];
  let input = "";
  let loading = false;
  let error: string | null = null;
  let live = "";
  let mode: "ws" | "rest" = "rest";
  let sessionId = "";
  let ws: WebSocket | null = null;
  let wsState: "connecting" | "open" | "closed" = "connecting";
  let intentionalClose = false;
  let reconnects = 0;
  let panelEl: HTMLElement | undefined;

  $: shown = visibleMessages(messages);

  function newTurnId(): string {
    try {
      return crypto.randomUUID();
    } catch {
      return `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    }
  }

  onMount(async () => {
    open = localStorage.getItem(WIDGET_OPEN_KEY) === "1";
    if (await chatServiceUp()) {
      mode = "ws";
      sessionId = localStorage.getItem(WIDGET_SESSION_KEY) ?? "";
      if (sessionId) {
        const res = await getChatSession(sessionId);
        if (res.ok) {
          messages = res.data.messages.map((m) => ({
            id: m.id,
            role: m.role as "user" | "assistant",
            content: m.content,
            timestamp: m.timestamp,
          }));
        } else {
          sessionId = ""; // stale id (Redis TTL) -> fresh session below
        }
      }
      if (!sessionId) {
        const res = await postChatCreate("");
        if (res.ok) {
          sessionId = res.data.id;
          localStorage.setItem(WIDGET_SESSION_KEY, sessionId);
        } else {
          mode = "rest";
        }
      }
      if (mode === "ws" && open) openSocket();
    }
    if (mode === "rest") {
      const saved = localStorage.getItem(WIDGET_MESSAGES_KEY);
      if (saved) {
        try {
          messages = JSON.parse(saved);
        } catch {
          messages = [];
        }
      }
    }
  });

  onDestroy(() => {
    intentionalClose = true;
    ws?.close();
  });

  function toggle() {
    open = !open;
    localStorage.setItem(WIDGET_OPEN_KEY, open ? "1" : "0");
    if (open && mode === "ws" && (!ws || ws.readyState !== WebSocket.OPEN)) openSocket();
    if (open) setTimeout(() => panelEl?.querySelector("input")?.focus(), 50);
  }

  function openSocket() {
    if (!sessionId) return;
    wsState = "connecting";
    ws = chatSocket(sessionId);
    ws.onopen = () => {
      wsState = "open";
      reconnects = 0;
    };
    ws.onmessage = (ev) => {
      let msg: { type: string; text?: string; error?: string };
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      const s = applyWsEvent({ live, loading }, msg);
      live = s.live;
      if (s.commit !== null && s.commit !== undefined) {
        messages = [...messages, { role: "assistant", content: s.commit, timestamp: new Date().toISOString() }];
      }
      if (s.error) error = s.error;
      loading = s.loading;
    };
    ws.onclose = () => {
      wsState = "closed";
      loading = false;
      // Bounded reconnect, then graceful degradation to REST.
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

  function persistLocal() {
    localStorage.setItem(WIDGET_MESSAGES_KEY, JSON.stringify(messages));
  }

  /** Browser-only state for this turn: current route + the setup rooms in
   *  localStorage (the control plane cannot see either). Labelled DATA by the
   *  service; empty when storage is blocked/unparseable. */
  function currentContext(): string {
    try {
      const setups = JSON.parse(localStorage.getItem(SETUPS_KEY) ?? "{}");
      return pageContext({ route: `${location.pathname}${location.search}`, setups });
    } catch {
      return "";
    }
  }

  async function handleSend() {
    const text = input.trim();
    if (!text || loading) return;
    loading = true;
    error = null;
    const turnId = newTurnId();
    messages = [...messages, { id: turnId, role: "user", content: text, timestamp: new Date().toISOString() }];
    input = "";

    if (mode === "ws" && ws && ws.readyState === WebSocket.OPEN) {
      live = "";
      ws.send(JSON.stringify(buildOutbound({ id: turnId, content: text, image: null, context: currentContext() })));
      return; // the done event completes the turn
    }
    if (mode === "ws") {
      error = "Chat socket is not connected — retrying…";
      loading = false;
      return;
    }
    // REST fallback. Streamed (chat:stream) for the same reason as the chat
    // page: a long generation (a chart analysis runs ~60s) outlives the
    // single-shot response wall-clock — the non-stream POST dies mid-request.
    // Deltas render into `live` like the WS path, then commit.
    const outbound: ChatOutboundMessage[] = buildRestOutbound(messages, turnId, null, null);
    live = "";
    const res = await streamChat(
      { session_id: sessionId || undefined, messages: outbound, context: currentContext() },
      (t) => { live += t; },
    );
    const streamed = live;
    live = "";
    loading = false;
    if (!res.ok) {
      error = res.error;
      return;
    }
    messages = [...messages, { role: "assistant", content: res.data.response || streamed, timestamp: new Date().toISOString() }];
    persistLocal();
  }
</script>

{#if open}
  <!-- svelte-ignore a11y-no-noninteractive-element-to-interactive-role a11y-no-noninteractive-element-interactions -->
  <section bind:this={panelEl} class="panel" role="dialog" aria-label="trading assistant" on:keydown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), handleSend())}>
    <header>
      <span>💬 دستیار تریدینگ</span>
      <span class="mode" class:ws={mode === "ws"}>{mode === "ws" ? (wsState === "open" ? "live" : wsState) : "rest"}</span>
      <button class="x" on:click={toggle} aria-label="close">✕</button>
    </header>
    <div class="msgs">
      {#if !messages.length && !live}
        <p class="hint">از وضعیت بازار، واچ‌ها، سیگنال‌ها یا اپرووال‌ها بپرس — advisory only.</p>
      {/if}
      {#each shown as m}
        <div class="msg {m.role}"><div class="bubble">{m.content}</div></div>
      {/each}
      {#if live}
        <div class="msg assistant"><div class="bubble">{live}<span class="caret">|</span></div></div>
      {:else if loading}
        <div class="msg assistant"><div class="bubble thinking">Thinking…</div></div>
      {/if}
      {#if error}<div class="err">{error}</div>{/if}
    </div>
    <footer>
      <input bind:value={input} placeholder="بپرس…" disabled={loading} />
      <button on:click={handleSend} disabled={loading || !input.trim()}>➤</button>
    </footer>
  </section>
{/if}
<button class="fab" on:click={toggle} aria-label="toggle assistant">💬</button>

<style>
  .fab {
    position: fixed; bottom: 20px; right: 20px; z-index: 50;
    width: 52px; height: 52px; border-radius: 50%; font-size: 1.4rem;
    border: 1px solid #30363d; background: #21262d; cursor: pointer;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
  }
  .fab:hover { background: #2d333b; }
  .panel {
    position: fixed; bottom: 84px; right: 20px; z-index: 50;
    width: min(380px, calc(100vw - 40px)); height: min(520px, calc(100vh - 160px));
    display: flex; flex-direction: column;
    border: 1px solid #30363d; border-radius: 12px; background: #0d1117;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.55); overflow: hidden;
  }
  header {
    display: flex; align-items: center; gap: 0.5rem;
    padding: 0.6rem 0.75rem; border-bottom: 1px solid #21262d; font-size: 0.85rem;
  }
  header span:first-child { flex: 1; }
  .mode { font-size: 0.7rem; color: #8b949e; border: 1px solid #30363d; border-radius: 6px; padding: 1px 6px; }
  .mode.ws { color: #3fb950; border-color: #3fb95066; }
  .x { background: none; border: none; color: #8b949e; cursor: pointer; font-size: 0.85rem; }
  .msgs { flex: 1; overflow-y: auto; padding: 0.75rem; display: flex; flex-direction: column; gap: 0.5rem; }
  .hint { color: #8b949e; font-size: 0.8rem; text-align: center; margin: auto 0; }
  .msg { display: flex; }
  .msg.user { justify-content: flex-end; }
  .bubble {
    max-width: 85%; padding: 0.45rem 0.65rem; border-radius: 10px;
    font-size: 0.82rem; line-height: 1.5; white-space: pre-wrap; word-break: break-word;
  }
  .msg.user .bubble { background: #1f6feb; color: #fff; }
  .msg.assistant .bubble { background: #161b22; border: 1px solid #30363d; }
  .thinking { color: #8b949e; }
  .caret { animation: blink 1s steps(2) infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  .err { color: #f85149; font-size: 0.75rem; }
  footer { display: flex; gap: 0.4rem; padding: 0.6rem; border-top: 1px solid #21262d; }
  footer input {
    flex: 1; padding: 0.5rem 0.65rem; border-radius: 8px;
    border: 1px solid #30363d; background: #161b22; color: inherit; font-size: 0.85rem;
  }
  footer button {
    padding: 0.5rem 0.8rem; border-radius: 8px; border: 1px solid #30363d;
    background: #21262d; color: inherit; cursor: pointer;
  }
  footer button:disabled { opacity: 0.5; cursor: default; }
</style>

