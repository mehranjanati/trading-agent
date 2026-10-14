package chat

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// ── outboundTexts ─────────────────────────────────────────────────────────────

func TestOutboundTextsScansOnlyRecentTurns(t *testing.T) {
	hist := []Message{
		msg("user", "ancient question"),      // 1 — beyond the cap
		msg("assistant", "ancient answer"),   // 2
		msg("user", "old question"),          // 3
		msg("assistant", "old answer"),       // 4
		msg("user", "latest btc question"),   // 5 (kept)
		msg("assistant", "latest answer"),    // 6 (kept)
		msg("user", "and ethusdt?"),          // 7 (kept)
	}
	got := strings.Join(outboundTexts(hist), " | ")
	if strings.Contains(got, "ancient") {
		t.Fatalf("turns beyond the 4-turn cap must not be scanned, got %q", got)
	}
	if !strings.Contains(got, "and ethusdt?") || !strings.Contains(got, "latest btc") {
		t.Fatalf("recent turns must be scanned, got %q", got)
	}
}

func TestOutboundTextsSkipsSystemTurns(t *testing.T) {
	hist := []Message{
		msg("system", "LIVE MARKET CONTEXT: BTCUSDT: 1"),
		msg("user", "what price?"),
	}
	got := strings.Join(outboundTexts(hist), " | ")
	if strings.Contains(got, "LIVE MARKET") {
		t.Fatalf("an injected market line must never be re-scanned, got %q", got)
	}
	if !strings.Contains(got, "what price?") {
		t.Fatalf("user turns must survive, got %q", got)
	}
}

// ── memStore: in-memory SessionStore for the WS turn test ─────────────────────

type memStore struct {
	mu         sync.Mutex
	msgs       map[string][]Message
	principles map[string]string
}

func newMemStore() *memStore {
	return &memStore{msgs: map[string][]Message{}, principles: map[string]string{}}
}

func (m *memStore) Create(id, p string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.msgs[id] = nil
	m.principles[id] = p
	return nil
}

func (m *memStore) Append(id string, msg Message) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.msgs[id] = append(m.msgs[id], msg)
	return nil
}

func (m *memStore) Messages(id string) ([]Message, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]Message(nil), m.msgs[id]...), nil
}

func (m *memStore) Principles(id string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.principles[id], nil
}

func (m *memStore) SetPrinciples(id, p string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.principles[id] = p
	return nil
}

func (m *memStore) Delete(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.msgs, id)
	delete(m.principles, id)
	return nil
}

// storedCount counts appended turns by role.
func (m *memStore) storedRoles(id string) []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]string, 0, len(m.msgs[id]))
	for _, mm := range m.msgs[id] {
		out = append(out, mm.Role)
	}
	return out
}

// ── full WS turn: market context is injected outbound but never persisted ─────

// wsTurnResult captures what actually reached the Worker AI route and what was
// stored, from one real WS turn against a live Service instance.
type wsTurnResult struct {
	AIRoles    []string // roles on the wire to the Worker, in order
	AIFirst    string   // content of messages[0]
	Stored     []string // roles persisted to the store
	MarketSeen []string // texts handed to the Market seam
	Done       string
}

func runWSTurn(t *testing.T, market func(ctx context.Context, texts ...string) string) wsTurnResult {
	t.Helper()

	// Fake Worker: capture the POST body, answer a one-frame SSE stream.
	var wire struct {
		Messages []struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"messages"`
	}
	ai := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &wire)
		w.Header().Set("content-type", "text/event-stream")
		w.Header().Set("x-ai-model", "@cf/qwen/qwen3-30b-a3b-fp8")
		fmt.Fprint(w, "data: {\"response\":\"model reply\"}\n\n")
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer ai.Close()

	st := newMemStore()
	_ = st.Create("chat_1_t", "")
	var seen []string
	var seenMu sync.Mutex
	var svc *Service
	if market == nil {
		// Nil seam: exactly the degraded/test deployment shape.
		svc = &Service{Store: st, AI: NewAIClient(ai.URL)}
	} else {
		wrapped := func(ctx context.Context, texts ...string) string {
			seenMu.Lock()
			seen = append(seen, texts...)
			seenMu.Unlock()
			return market(ctx, texts...)
		}
		svc = &Service{Store: st, AI: NewAIClient(ai.URL), Market: wrapped}
	}
	srv := httptest.NewServer(svc)
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/ws/chat/chat_1_t", nil)
	if err != nil {
		t.Fatalf("ws dial: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	turn, _ := json.Marshal(map[string]any{"type": "message", "id": "turn_1", "content": "تحلیل btc و ethusdt"})
	if err := conn.Write(ctx, websocket.MessageText, turn); err != nil {
		t.Fatalf("ws write: %v", err)
	}

	var res wsTurnResult
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		_, raw, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("ws read: %v", err)
		}
		var ev ChatEvent
		if json.Unmarshal(raw, &ev) != nil {
			continue
		}
		if ev.Type == "error" {
			t.Fatalf("turn errored: %s", ev.Error)
		}
		if ev.Type == "done" {
			res.Done = ev.Text
			break
		}
	}
	if res.Done == "" {
		t.Fatal("turn never reached the done event")
	}

	seenMu.Lock()
	res.MarketSeen = seen
	seenMu.Unlock()
	for _, m := range wire.Messages {
		res.AIRoles = append(res.AIRoles, m.Role)
	}
	if len(wire.Messages) > 0 {
		res.AIFirst = wire.Messages[0].Content
	}
	res.Stored = st.storedRoles("chat_1_t")
	return res
}

func TestWSTurnInjectsMarketSystemMessage(t *testing.T) {
	res := runWSTurn(t, func(context.Context, ...string) string {
		return "LIVE MARKET CONTEXT: BTCUSDT: 115400.5"
	})
	if len(res.AIRoles) == 0 || res.AIRoles[0] != "system" {
		t.Fatalf("market context must lead the outbound window, got roles %v", res.AIRoles)
	}
	if !strings.Contains(res.AIFirst, "LIVE MARKET CONTEXT") {
		t.Fatalf("first wire message must carry the market line, got %q", res.AIFirst)
	}
	// Persistence contract: only user + assistant land in the store. The price
	// snapshot is per-turn — a later turn must never quote it as history.
	if len(res.Stored) != 2 || res.Stored[0] != "user" || res.Stored[1] != "assistant" {
		t.Fatalf("store must hold only user+assistant, got %v", res.Stored)
	}
	// The seam must receive the turn texts so the universe covers asked-about
	// symbols (btc / ethusdt here).
	joined := strings.Join(res.MarketSeen, " ")
	if !strings.Contains(joined, "btc") || !strings.Contains(joined, "ethusdt") {
		t.Fatalf("Market seam must see the user turn, got %q", joined)
	}
}

func TestWSTurnWithoutMarketSeamStillWorks(t *testing.T) {
	// Nil Market (degraded/test deployments): the turn must proceed with no
	// system message prepended — not error out.
	res := runWSTurn(t, nil)
	if len(res.AIRoles) > 0 && res.AIRoles[0] == "system" {
		t.Fatalf("no market seam means no injected system turn, got %v", res.AIRoles)
	}
	if res.Done == "" {
		t.Fatal("turn must complete without a Market seam")
	}
}

func TestWSTurnEmptyMarketTextIsNotInjected(t *testing.T) {
	// A seam returning "" (nothing truthful to say) must not send an empty
	// system turn — the guard lives in handleWS.
	res := runWSTurn(t, func(context.Context, ...string) string { return "" })
	if len(res.AIRoles) > 0 && res.AIRoles[0] == "system" && res.AIFirst == "" {
		t.Fatal("empty market text must not become an empty system message")
	}
	if res.Done == "" {
		t.Fatal("turn must complete")
	}
}
