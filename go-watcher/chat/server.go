// HTTP + WebSocket server for the chat service.
//
// HTTP (state ops):
//
//	POST /api/chat/create        {principles?}          -> {id}
//	GET  /api/chat/{id}                                 -> {messages, principles}
//	DELETE /api/chat/{id}                               -> {}
//	POST /api/chat/{id}/principles {content}            -> {}
//
// WebSocket /ws/chat/{id} (real-time turn loop):
//
//	client -> {"type":"message","content":"..."}  (user turn)
//	client -> {"type":"principles","content":"..."}
//	server -> {"type":"chunk","text":"..."}        (streamed deltas)
//	server -> {"type":"done","codeBlocks":[...]}   (turn complete, persisted)
//	server -> {"type":"error","error":"..."}
package chat

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
)

// SessionStore is the persistence seam the HTTP/WS handlers talk through.
// *Store (Redis) is the production implementation; tests substitute a stub so
// routing can be proven without a live Redis.
type SessionStore interface {
	Create(id, principles string) error
	Append(id string, m Message) error
	Messages(id string) ([]Message, error)
	Principles(id string) (string, error)
	SetPrinciples(id, principles string) error
	Delete(id string) error
}

type Service struct {
	Store SessionStore
	AI    *AIClient
	// Origins is the accepted WebSocket Origin allow-list. Empty means "any
	// origin" (local dev / same-host deployments); browsers always send Origin,
	// so an explicit list is the fail-closed option for public tunnels.
	Origins []string
}

// chatCORS — advisory-only routes, so every method/header is permitted, but
// only the declared headers are advertised (the browser enforces the list).
var chatCORS = map[string]string{
	"access-control-allow-origin":  "*",
	"access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
	"access-control-allow-headers": "content-type, accept",
	"access-control-max-age":       "600",
}

func withChatCORS(w http.ResponseWriter, r *http.Request) bool {
	for k, v := range chatCORS {
		w.Header().Set(k, v)
	}
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return false
	}
	return true
}

type wsIn struct {
	Type    string `json:"type"`
	Content string `json:"content"`
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeChatErr(w http.ResponseWriter, code int, errCode, msg string) {
	writeJSON(w, code, map[string]any{"code": errCode, "message": msg})
}

func nowUTC() string { return time.Now().UTC().Format(time.RFC3339) }

func randomSuffix() string {
	const cs = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, 6)
	now := time.Now().UnixNano()
	for i := range b {
		b[i] = cs[int(now>>uint(i*3))%len(cs)]
	}
	return string(b)
}

func newID() string {
	return fmt.Sprintf("chat_%d_%s", time.Now().UnixMilli(), randomSuffix())
}

func (s *Service) handleCreate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Principles string `json:"principles"`
	}
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&body)
	}
	id := newID()
	if err := s.Store.Create(id, body.Principles); err != nil {
		writeChatErr(w, http.StatusBadGateway, "REDIS", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": id})
}

func (s *Service) handleGet(w http.ResponseWriter, r *http.Request) {
	id := chatID(r)
	msgs, err := s.Store.Messages(id)
	if err != nil {
		writeChatErr(w, http.StatusBadGateway, "REDIS", err.Error())
		return
	}
	principles, _ := s.Store.Principles(id)
	writeJSON(w, http.StatusOK, map[string]any{"messages": msgs, "principles": principles})
}

func (s *Service) handleDelete(w http.ResponseWriter, r *http.Request) {
	id := chatID(r)
	if err := s.Store.Delete(id); err != nil {
		writeChatErr(w, http.StatusBadGateway, "REDIS", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
}

func (s *Service) handlePrinciples(w http.ResponseWriter, r *http.Request) {
	id := chatID(r)
	var body struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeChatErr(w, http.StatusBadRequest, "VALIDATION", "bad JSON")
		return
	}
	if err := s.Store.SetPrinciples(id, body.Content); err != nil {
		writeChatErr(w, http.StatusBadGateway, "REDIS", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"saved": true})
}

func (s *Service) handleWS(w http.ResponseWriter, r *http.Request) {
	id := chatID(r)
	// Same-origin (or Origin-less, e.g. a CLI dial) is always allowed. A
	// browser Origin is matched against the configured allow-list; an empty
	// list means "accept any" for local dev.
	accept := &websocket.AcceptOptions{InsecureSkipVerify: true}
	if len(s.Origins) > 0 {
		if origin := r.Header.Get("Origin"); origin != "" {
			if !originAllowed(origin, s.Origins) {
				writeChatErr(w, http.StatusForbidden, "ORIGIN", "origin not allowed")
				return
			}
		}
	}
	c, err := websocket.Accept(w, r, accept)
	if err != nil {
		return
	}
	defer c.CloseNow()
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
	defer cancel()
	c.SetReadLimit(64 * 1024)

	send := func(ev ChatEvent) error {
		raw, err := json.Marshal(ev)
		if err != nil {
			return err
		}
		wctx, wcancel := context.WithTimeout(ctx, 30*time.Second)
		defer wcancel()
		return c.Write(wctx, websocket.MessageText, raw)
	}

	for {
		_, raw, err := c.Read(ctx)
		if err != nil {
			return
		}
		var in wsIn
		if json.Unmarshal(raw, &in) != nil {
			_ = send(ChatEvent{Type: "error", Error: "bad envelope"})
			continue
		}
		switch in.Type {
		case "principles":
			if err := s.Store.SetPrinciples(id, in.Content); err != nil {
				_ = send(ChatEvent{Type: "error", Error: err.Error()})
			}
		case "message":
			if strings.TrimSpace(in.Content) == "" {
				_ = send(ChatEvent{Type: "error", Error: "empty message"})
				continue
			}
			userMsg := Message{Role: "user", Content: in.Content, Timestamp: nowUTC()}
			if err := s.Store.Append(id, userMsg); err != nil {
				_ = send(ChatEvent{Type: "error", Error: err.Error()})
				continue
			}
			history, err := s.Store.Messages(id)
			if err != nil {
				_ = send(ChatEvent{Type: "error", Error: err.Error()})
				continue
			}
			principles, _ := s.Store.Principles(id)
			window := ApplyWindow(history, principles)
			res, err := s.AI.Stream(ctx, window, principles, func(chunk string) {
				_ = send(ChatEvent{Type: "chunk", Text: chunk})
			})
			if err != nil {
				_ = send(ChatEvent{Type: "error", Error: err.Error()})
				continue
			}
			aiMsg := Message{Role: "assistant", Content: res.Text, Timestamp: nowUTC()}
			if err := s.Store.Append(id, aiMsg); err != nil {
				_ = send(ChatEvent{Type: "error", Error: err.Error()})
				continue
			}
			_ = send(ChatEvent{Type: "done", Text: res.Text, CodeBlocks: res.CodeBlocks, Model: res.Model})
		default:
			_ = send(ChatEvent{Type: "error", Error: "unknown type"})
		}
	}
}

type chatPathKey struct{ name string }

var idKey = chatPathKey{"id"}

func setChatPathValue(r *http.Request, key any, value string) *http.Request {
	ctx := context.WithValue(r.Context(), key, value)
	return r.WithContext(ctx)
}

// chatID reads the id the router attached. r.PathValue is NOT usable here:
// it only resolves against Go 1.22 ServeMux patterns, and the service is
// mounted on a plain prefix, so every handler would silently see "".
func chatID(r *http.Request) string {
	v, _ := r.Context().Value(idKey).(string)
	return v
}

// originAllowed reports whether origin exactly matches an entry of allowed.
func originAllowed(origin string, allowed []string) bool {
	for _, a := range allowed {
		if a == origin {
			return true
		}
	}
	return false
}

// ServeHTTP dispatches incoming requests by path+method.
func (s *Service) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !withChatCORS(w, r) {
		return
	}
	path := r.URL.Path
	method := r.Method

	switch {
	case path == "/api/chat/create" && method == "POST":
		s.handleCreate(w, r)
		return
	case strings.HasPrefix(path, "/api/chat/") && !strings.HasSuffix(path, "/principles"):
		parts := strings.Split(strings.TrimPrefix(path, "/api/chat/"), "/")
		if len(parts) >= 1 && parts[0] != "" && len(parts) <= 2 {
			id := parts[0]
			if !strings.Contains(id, "/") {
				r = setChatPathValue(r, idKey, id)
				switch method {
				case "GET":
					s.handleGet(w, r)
				case "DELETE":
					s.handleDelete(w, r)
				default:
					http.NotFound(w, r)
				}
				return
			}
		}
	case strings.HasSuffix(path, "/principles") && method == "POST":
		id := strings.TrimSuffix(path[len("/api/chat/"):], "/principles")
		if id != "" && !strings.Contains(id, "/") {
			r = setChatPathValue(r, idKey, id)
			s.handlePrinciples(w, r)
			return
		}
	case strings.HasPrefix(path, "/ws/chat/"):
		id := strings.TrimPrefix(path, "/ws/chat/")
		if id != "" && !strings.Contains(id, "/") {
			r = setChatPathValue(r, idKey, id)
			s.handleWS(w, r)
			return
		}
	}
	http.NotFound(w, r)
}
