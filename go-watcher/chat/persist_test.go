// persist_test.go — ADR-014: the durable chat bridge. No Redis and no D1 are
// needed here: the Worker is an httptest server, which is exactly the seam this
// type owns (Go never writes D1 — D-08).
package chat

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSessionIDForSymbol(t *testing.T) {
	cases := map[string]string{
		"openusdt":   "sym_OPENUSDT",
		" OPENUSDT ": "sym_OPENUSDT",
		"BTCUSDT":    "sym_BTCUSDT",
		"btc":        "",
		"btc-usdt":   "",
		"":           "",
	}
	for in, want := range cases {
		if got := SessionIDForSymbol(in); got != want {
			t.Fatalf("SessionIDForSymbol(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestPersisterAppendAndHistory(t *testing.T) {
	var turn persistTurn
	var histQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-agent-token") != "tok" {
			t.Errorf("%s %s: missing x-agent-token", r.Method, r.URL.Path)
		}
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/chat:append":
			raw, _ := io.ReadAll(r.Body)
			if err := json.Unmarshal(raw, &turn); err != nil {
				t.Errorf("append body: %v", err)
			}
			_, _ = w.Write([]byte(`{"id":"cmsg_1"}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/chat:history":
			histQuery = r.URL.RawQuery
			_, _ = w.Write([]byte(`{"session_id":"sym_OPENUSDT","symbol":"OPENUSDT","principles":"p","messages":[{"id":"m1","role":"user","content":"hi","timestamp":"2026-11-04T10:00:00Z"}]}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/chat:delete":
			_, _ = w.Write([]byte(`{"deleted":2}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	p := NewPersister(srv.URL, "tok")
	if p == nil {
		t.Fatal("NewPersister returned nil for a real base")
	}
	msg := Message{
		ID: "turn-1", Role: "user", Content: "hi", Timestamp: "2026-11-04T10:00:00Z",
		Attachments: []Attachment{{MediaType: "image/png", DataURL: "data:image/png;base64,AA", Bytes: 5}},
	}
	if err := p.Append(context.Background(), "sym_OPENUSDT", msg); err != nil {
		t.Fatalf("Append: %v", err)
	}
	if turn.SessionID != "sym_OPENUSDT" || turn.Role != "user" || turn.MessageID != "turn-1" {
		t.Fatalf("append body = %+v", turn)
	}
	// The inline data URL must never reach D1 (2 MB row cap, ADR-010).
	if len(turn.Attachments) != 1 || turn.Attachments[0].DataURL != "" {
		t.Fatalf("data URL leaked to the durable log: %+v", turn.Attachments)
	}
	if turn.Attachments[0].MediaType != "image/png" || turn.Attachments[0].Bytes != 5 {
		t.Fatalf("attachment metadata lost: %+v", turn.Attachments[0])
	}

	msgs, principles, err := p.History(context.Background(), "sym_OPENUSDT", 10)
	if err != nil {
		t.Fatalf("History: %v", err)
	}
	if !strings.Contains(histQuery, "session=sym_OPENUSDT") || !strings.Contains(histQuery, "limit=10") {
		t.Fatalf("history query = %q", histQuery)
	}
	if len(msgs) != 1 || msgs[0].Content != "hi" || msgs[0].Role != "user" {
		t.Fatalf("history messages = %+v", msgs)
	}
	if principles != "p" {
		t.Fatalf("principles = %q", principles)
	}

	if err := p.Delete(context.Background(), "sym_OPENUSDT"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
}

func TestPersisterNilIsNoOp(t *testing.T) {
	var p *Persister
	ctx := context.Background()
	if err := p.Append(ctx, "sym_OPENUSDT", Message{Role: "user", Content: "hi"}); err != nil {
		t.Fatalf("nil Append: %v", err)
	}
	if msgs, principles, err := p.History(ctx, "sym_OPENUSDT", 0); err != nil || msgs != nil || principles != "" {
		t.Fatalf("nil History = %v %q %v", msgs, principles, err)
	}
	if err := p.Delete(ctx, "sym_OPENUSDT"); err != nil {
		t.Fatalf("nil Delete: %v", err)
	}
	if NewPersister("  ", "") != nil {
		t.Fatal("an empty base must disable the durable log")
	}
}

func TestURLQueryEscape(t *testing.T) {
	if got := urlQueryEscape("sym_OPENUSDT"); got != "sym_OPENUSDT" {
		t.Fatalf("safe id changed: %q", got)
	}
	if got := urlQueryEscape("a b&c"); got != "a%20b%26c" {
		t.Fatalf("escape = %q", got)
	}
}
