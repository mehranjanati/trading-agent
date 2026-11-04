<script lang="ts">
  // RoomChat — the cockpit's INLINE assistant (docs/20 S3, E15-T01).
  //
  // A second skin over the SAME advisory chat service, bound to the ROOM
  // session: `chat_session_{symbol}` (setups.ts chatSessionKey), so a
  // conversation started here continues on /chat?symbol=… and vice versa.
  // When `symbol` is empty it degrades to the legacy global session
  // (`chat_session_id`) — the same key the floating ChatWidget uses.
  //
  // Advisory only (D-08): it can propose a setup (the Stalk card renders it),
  // it can never submit an order or an approval. Chart attachments, draft
  // saving and the principles editor stay on the full /chat page — this panel
  // links there instead of re-implementing them (Q-18 keeps /chat alive).
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
    visibleMessages,
    applyWsEvent,
    buildOutbound,
    buildRestOutbound,
    pageContext,
    SETUPS_KEY,
  } from "$lib/chat-widget-core.mjs";
  import { chatSessionKey } from "$lib/setups";

  export let symbol = "";

  type Msg = { id?: string; role: "user" | "assistant"; content: string; timestamp: string };

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
  let msgsEl: HTMLElement | undefined;

  // Session keys: the room's when a symbol is bound, the legacy global ones
  // otherwise (identical to the floating widget, so both stay in sync).
  $: sessionKey = symbol ? chatSessionKey(symbol) : "chat_session_id";
  $: messagesKey = symbol ? `chat_messages_${symbol}` : "chat_messages";

  function newTurnId(): string {
    try {
      return crypto.randomUUID();
    } catch {
      return `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    }
  }

  onMount(() => {
    void boot();
    return () => {
      intentionalClose = true;
      ws?.close();
    };
  });

  async function boot() {
    if (!(await chatServiceUp())) {
      mode = "rest";
      const saved = localStorage.getItem(messagesKey);
      if (saved) {
        try {
          messages = JSON.parse(saved);
        } catch {
          messages = [];
        }
      }
      return;
    }
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
        }));
      } else {
        sessionId = ""; // stale id (Redis TTL) → fresh session below
      }
    }
    if (!sessionId) {
      const res = await postChatCreate("");
      if (res.ok) {
        sessionId = res.data.id;
        localStorage.setItem(sessionKey, sessionId);
      } else {
        mode = "rest";
        return;
      }
    }
    openSocket();
  }

  onDestroy(() => {
    intentionalClose = true;
    ws?.close();
  });

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
      // Bounded reconnect, then graceful degradation to REST — the same policy
      // as the floating widget, so both skins behave identically under flaps.
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
    try {
      localStorage.setItem(messagesKey, JSON.stringify(messages));
    } catch {
      /* storage blocked — in-memory still works */
    }
  }

  /** Browser-only context for this turn: route + setup rooms (labelled DATA). */
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
    // REST fallback, streamed: a long generation outlives the single-shot
    // wall-clock (measured 2026-10-18 — see the streamChat note in api.ts).
    const outbound: ChatOutboundMessage[] = buildRestOutbound(messages, turnId, null, null);
    live = "";
    const res = await streamChat(
      { session_id: sessionId || undefined, messages: outbound, context: currentContext() },
      (t) => {
        live += t;
      },
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

  // Keep the tail visible as turns arrive.
  $: if (msgsEl && (messages.length || live)) {
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  $: shown = visibleMessages(messages);
</script>

<section class="roomchat" aria-label="advisory assistant {symbol ? 'for ' + symbol : '(all symbols)'}">
  <header>
    <span>💬 assistant{symbol ? ` · ${symbol}` : ""}</span>
    <span class="mode" class:ws={mode === "ws"}>{mode === "ws" ? (wsState === "open" ? "live" : wsState) : "rest"}</span>
    <a class="full" href={symbol ? `/chat?symbol=${symbol}` : "/chat"} title="charts, drafts and principles live here">full chat ↗</a>
  </header>
  <div class="msgs" bind:this={msgsEl}>
    {#if !messages.length && !live}
      <p class="hint">advisory only — بپرس، تحلیل بگیر، پیشنهاد setup ببین. سفارش از اینجا ارسال نمی‌شود (D-08).</p>
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
    <input
      bind:value={input}
      placeholder={symbol ? `بپرس… (${symbol})` : "بپرس…"}
      disabled={loading}
      on:keydown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), handleSend())}
    />
    <button on:click={handleSend} disabled={loading || !input.trim()}>➤</button>
  </footer>
</section>

<style>
  .roomchat {
    display: flex;
    flex-direction: column;
    background: #0d1117;
    border: 1px solid #1e2330;
    border-radius: 10px;
    overflow: hidden;
    min-height: 320px;
  }
  header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid #21262d;
    font-size: 0.8rem;
  }
  header span:first-child {
    flex: 1;
    font-weight: 600;
  }
  .mode {
    font-size: 0.65rem;
    color: #8b949e;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 1px 6px;
  }
  .mode.ws {
    color: #3fb950;
    border-color: #3fb95066;
  }
  .full {
    color: #8b949e;
    font-size: 0.7rem;
    text-decoration: none;
  }
  .full:hover {
    color: #e6e9ef;
  }
  .msgs {
    flex: 1;
    overflow-y: auto;
    padding: 0.65rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    max-height: 420px;
  }
  .hint {
    color: #8b949e;
    font-size: 0.75rem;
    text-align: center;
    margin: auto 0;
  }
  .msg {
    display: flex;
  }
  .msg.user {
    justify-content: flex-end;
  }
  .bubble {
    max-width: 88%;
    padding: 0.4rem 0.6rem;
    border-radius: 10px;
    font-size: 0.78rem;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .msg.user .bubble {
    background: #1f6feb;
    color: #fff;
  }
  .msg.assistant .bubble {
    background: #161b22;
    border: 1px solid #30363d;
  }
  .thinking {
    color: #8b949e;
  }
  .caret {
    animation: blink 1s steps(2) infinite;
  }
  @keyframes blink {
    50% {
      opacity: 0;
    }
  }
  .err {
    color: #f85149;
    font-size: 0.72rem;
  }
  footer {
    display: flex;
    gap: 0.4rem;
    padding: 0.5rem;
    border-top: 1px solid #21262d;
  }
  footer input {
    flex: 1;
    padding: 0.45rem 0.6rem;
    border-radius: 8px;
    border: 1px solid #30363d;
    background: #161b22;
    color: inherit;
    font-size: 0.8rem;
  }
  footer button {
    padding: 0.45rem 0.7rem;
    border-radius: 8px;
    border: 1px solid #30363d;
    background: #21262d;
    color: inherit;
    cursor: pointer;
  }
  footer button:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
