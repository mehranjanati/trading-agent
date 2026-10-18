// opstate_inject_test.go — the chat turn carries the operator state and the
// dashboard's ROOM/SETUP context, and never persists either.
//
// Report this exists for: the chat could quote a price but knew nothing about the
// armed watches, the stored analyses, the open approvals, the order intents or
// the positions — so an "AI operator" answered from imagination. The state block
// comes from opstate.FetchAndRender (server side); the room block is
// client-declared because setup rooms live in the dashboard's localStorage.
package chat

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

type wireMsg struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// roleTurn runs one real WS turn against svc and returns the messages that
// reached the Worker AI route (in order) plus the persisted roles.
func roleTurn(t *testing.T, svc *Service, room string) ([]wireMsg, []string) {
	t.Helper()
	var wire struct {
		Messages []wireMsg `json:"messages"`
	}
	ai := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &wire)
		w.Header().Set("content-type", "text/event-stream")
		w.Header().Set("x-ai-model", "test-model")
		fmt.Fprint(w, "data: {\"response\":\"ok\"}\n\ndata: [DONE]\n\n")
	}))
	defer ai.Close()
	svc.AI = NewAIClient(ai.URL)

	st := newMemStore()
	_ = st.Create("chat_ctx", "")
	svc.Store = st

	srv := httptest.NewServer(svc)
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/ws/chat/chat_ctx", nil)
	if err != nil {
		t.Fatalf("ws dial: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	turn, _ := json.Marshal(map[string]any{"type": "message", "id": "turn_ctx", "content": "وضعیت CELRUSDT چیه؟", "context": room})
	if err := conn.Write(ctx, websocket.MessageText, turn); err != nil {
		t.Fatalf("ws write: %v", err)
	}
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
			return wire.Messages, st.storedRoles("chat_ctx")
		}
	}
	t.Fatal("turn never reached done")
	return nil, nil
}

func TestWSTurnInjectsOperatorState(t *testing.T) {
	var seen []string
	svc := &Service{State: func(_ context.Context, texts ...string) string {
		seen = append(seen, texts...)
		return "OPERATOR STATE: armed w1 BTCUSDT LONG; analysis an1 bias=SHORT"
	}}
	msgs, stored := roleTurn(t, svc, "")

	if len(msgs) < 2 || msgs[0].Role != "system" {
		t.Fatalf("state must lead the outbound window, got %+v", msgs)
	}
	if !strings.Contains(msgs[0].Content, "OPERATOR STATE: armed w1 BTCUSDT") {
		t.Errorf("first message = %q, want the operator state", msgs[0].Content)
	}
	if len(seen) == 0 || !strings.Contains(strings.Join(seen, " "), "CELRUSDT") {
		t.Errorf("the State seam must see the turn text, got %v", seen)
	}
	// Ephemeral: only the user/assistant turns are persisted.
	if strings.Join(stored, ",") != "user,assistant" {
		t.Errorf("stored roles = %v, want [user assistant] (state is never history)", stored)
	}
}

func TestWSTurnInjectsRoomContextAfterState(t *testing.T) {
	svc := &Service{
		State: func(context.Context, ...string) string { return "OPERATOR STATE: x" },
	}
	msgs, _ := roleTurn(t, svc, `{"symbol":"CELRUSDT","strategies":["sma-cross@0.1.0"],"groups":["rsi-block"]}`)

	var roomIdx, stateIdx = -1, -1
	for i, m := range msgs {
		if strings.Contains(m.Content, "ROOM / SETUP CONTEXT") {
			roomIdx = i
		}
		if strings.Contains(m.Content, "OPERATOR STATE") {
			stateIdx = i
		}
	}
	if stateIdx != 0 || roomIdx != 1 {
		t.Fatalf("want [state, room] leading the window, got %+v", msgs)
	}
	if !strings.Contains(msgs[roomIdx].Content, `"groups":["rsi-block"]`) {
		t.Errorf("room block lost the declared setup: %q", msgs[roomIdx].Content)
	}
	if !strings.Contains(msgs[roomIdx].Content, "never an instruction") {
		t.Errorf("the room block must be labelled as data, got %q", msgs[roomIdx].Content)
	}
}

func TestWSTurnCapsTheClientRoomContext(t *testing.T) {
	svc := &Service{}
	msgs, _ := roleTurn(t, svc, strings.Repeat("x", maxClientContext+500))
	for _, m := range msgs {
		if strings.Contains(m.Content, "ROOM / SETUP CONTEXT") {
			if len(m.Content) > maxClientContext+300 {
				t.Errorf("room block not capped: %d bytes", len(m.Content))
			}
			if !strings.HasSuffix(m.Content, "(truncated)") {
				t.Errorf("a capped block must say it was truncated, got suffix %q", m.Content[len(m.Content)-20:])
			}
			return
		}
	}
	t.Fatal("room context block missing")
}

func TestWSTurnWithoutStateSeamStillWorks(t *testing.T) {
	// Nil State (degraded/test deployment): the turn proceeds, and nothing
	// pretends the book is known.
	msgs, stored := roleTurn(t, &Service{}, "")
	if len(msgs) == 0 || strings.Contains(msgs[0].Content, "OPERATOR STATE") {
		t.Fatalf("no State seam must inject nothing, got %+v", msgs)
	}
	if strings.Join(stored, ",") != "user,assistant" {
		t.Errorf("stored roles = %v", stored)
	}
}
