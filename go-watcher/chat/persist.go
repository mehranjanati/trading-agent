// Persistence bridge (ADR-014): D1 is the canonical chat log, the Worker owns
// every D1 write (D-08), and Redis stays a hot cache with a 24h TTL.
//
// WHY: a transcript used to live only in Redis (`chat:{id}:msgs`, 24h TTL) and
// its session id only in the browser's localStorage, so a day of inactivity, a
// Redis restart or another device wiped the conversation. With this bridge the
// service mirrors every turn to `POST /api/chat:append` and, on a Redis miss,
// rehydrates the window from `GET /api/chat:history` — the thread is permanent.
//
// SESSION MODEL: one permanent thread per venue symbol, `sym_<SYMBOL>`.
//
// Fail-soft by design: chat is advisory, so a Worker/D1 outage must never
// silence an answer — it only means the turn is not durable.
package chat

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// symRe is the venue symbol shape used everywhere else (signals, watches, the
// cockpit): a wrong name must never mint a second thread for the same coin.
var symRe = regexp.MustCompile(`^[A-Z]{2,12}USDT$`)

// SessionIDForSymbol returns the deterministic thread id for one symbol
// ("sym_OPENUSDT"), or "" when the input is not a venue symbol.
func SessionIDForSymbol(symbol string) string {
	s := strings.ToUpper(strings.TrimSpace(symbol))
	if !symRe.MatchString(s) {
		return ""
	}
	return "sym_" + s
}

// Persister talks to the Worker's durable chat routes. A nil *Persister is
// valid and means "no durable log configured" — every method is a no-op then.
type Persister struct {
	Base  string // Workers URL (no trailing slash)
	Token string // x-agent-token the Go plane sends on service routes
	HTTP  *http.Client
}

// NewPersister builds the bridge; "" base returns nil (durable log disabled).
func NewPersister(base, token string) *Persister {
	base = strings.TrimRight(strings.TrimSpace(base), "/")
	if base == "" {
		return nil
	}
	return &Persister{Base: base, Token: token, HTTP: &http.Client{Timeout: 8 * time.Second}}
}

type persistTurn struct {
	SessionID   string       `json:"session_id"`
	Role        string       `json:"role"`
	Content     string       `json:"content"`
	Attachments []Attachment `json:"attachments,omitempty"`
	MessageID   string       `json:"message_id,omitempty"`
	At          string       `json:"at"`
}

type historyResponse struct {
	SessionID  string    `json:"session_id"`
	Symbol     string    `json:"symbol"`
	Principles string    `json:"principles"`
	Messages   []Message `json:"messages"`
}

// metadataOnly strips the inline data URL: the BYTES live in R2
// (chat_attachments) and D1 caps a row at 2,000,000 bytes (ADR-010).
func metadataOnly(atts []Attachment) []Attachment {
	out := make([]Attachment, 0, len(atts))
	for _, a := range atts {
		out = append(out, Attachment{MediaType: a.MediaType, Detail: a.Detail, Bytes: a.Bytes})
	}
	return out
}

func (p *Persister) do(ctx context.Context, method, path string, body any) ([]byte, error) {
	var rdr io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("chat: persist marshal: %w", err)
		}
		rdr = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, p.Base+path, rdr)
	if err != nil {
		return nil, err
	}
	req.Header.Set("accept", "application/json")
	if body != nil {
		req.Header.Set("content-type", "application/json")
	}
	if p.Token != "" {
		req.Header.Set("x-agent-token", p.Token)
	}
	resp, err := p.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("chat: persist %s: %w", path, err)
	}
	defer resp.Body.Close()
	payload, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, fmt.Errorf("chat: persist %s: status %d: %s", path, resp.StatusCode, strings.TrimSpace(string(payload)))
	}
	return payload, nil
}

// Append mirrors ONE turn into D1. Callers ignore the error (fail-soft).
func (p *Persister) Append(ctx context.Context, sessionID string, m Message) error {
	if p == nil {
		return nil
	}
	at := m.Timestamp
	if at == "" {
		at = time.Now().UTC().Format(time.RFC3339)
	}
	_, err := p.do(ctx, http.MethodPost, "/api/chat:append", persistTurn{
		SessionID:   sessionID,
		Role:        m.Role,
		Content:     m.Content,
		Attachments: metadataOnly(m.Attachments),
		MessageID:   m.ID,
		At:          at,
	})
	return err
}

// History reads the durable transcript for a session (oldest first).
func (p *Persister) History(ctx context.Context, sessionID string, limit int) ([]Message, string, error) {
	if p == nil {
		return nil, "", nil
	}
	path := "/api/chat:history?session=" + urlQueryEscape(sessionID)
	if limit > 0 {
		path += fmt.Sprintf("&limit=%d", limit)
	}
	raw, err := p.do(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, "", err
	}
	var hr historyResponse
	if err := json.Unmarshal(raw, &hr); err != nil {
		return nil, "", fmt.Errorf("chat: persist history decode: %w", err)
	}
	return hr.Messages, hr.Principles, nil
}

// Delete clears the durable thread (the Redis cache is cleared separately).
func (p *Persister) Delete(ctx context.Context, sessionID string) error {
	if p == nil {
		return nil
	}
	_, err := p.do(ctx, http.MethodPost, "/api/chat:delete", map[string]string{"session_id": sessionID})
	return err
}

// urlQueryEscape keeps the session id URL-safe without importing net/url at
// every call site (ids are sym_<SYMBOL> or chat_<ts>_<rand>, both safe, but a
// caller could pass anything).
func urlQueryEscape(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_', r == '.', r == '~':
			b.WriteRune(r)
		default:
			b.WriteString(fmt.Sprintf("%%%02X", r))
		}
	}
	return b.String()
}
