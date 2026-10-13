// HTTP + WebSocket server for the chat service.
//
// HTTP (state ops):
//
//	POST /api/chat/create        {principles?}          → {id}
//	GET  /api/chat/{id}                                 → {messages, principles}
//	DELETE /api/chat/{id}                               → {}
//	POST /api/chat/{id}/principles {content}            → {}
//
// WebSocket /ws/chat/{id} (real-time turn loop):
//
//	client → {"type":"message","content":"..."}  (user turn)
//	client → {"type":"principles","content":"..."}
//	server → {"type":"chunk","text":"..."}        (streamed deltas)
//	server → {"type":"done","codeBlocks":[...]}   (turn complete, persisted)
//	server → {"type":"error","error":"..."}
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

// Service wires the store + AI client for the mux.
type Service struct {
	Store *Store
	AI    *AIClient
}

// wsIn is the client → server WS envelope.
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

// Handler builds the chat mux (path patterns need Go 1.22+).
func (s *Service) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/chat/create", s.handleCreate)
	mux.HandleFunc("GET /api/chat/{id}", s.handleGet)
	mux.HandleFunc("DELETE /api/chat/{id}", s.handleDelete)
	mux.HandleFunc("POST /api/chat/{id}/principles", s.handlePrinciples)
	mux.HandleFunc("/ws/chat/{id}", s.handleWS)
	return mux
}

func newID() string {
	return fmt.Sprintf("chat_%d_%s", time.Now().UnixMilli(), randomSuffix())
}

func randomSuffix() string {
	const cs = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, 6)
	now := time.Now().UnixNano()
	for i := range b {
		b[i] = cs[int(now>>uint(i*3))%len(cs)]
	}
	return string(b)
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
	id := r.PathValue("id")
	msgs, err := s.Store.Messages(id)
	if err != nil {
		writeChatErr(w, http.StatusBadGateway, "REDIS", err.Error())
		return
	}
	principles, _ := s.Store.Principles(id)
	writeJSON(w, http.StatusOK, map[string]any{"messages": msgs, "principles": principles})
}

func (s *Service) handleDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := s.Store.Delete(id); err != nil {
		writeChatErr(w, http.StatusBadGateway, "REDIS", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
}

func (s *Service) handlePrinciples(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
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

// handleWS is the real-time turn loop: one user message → streamed chunks →
// done (persisted). The socket stays open for further turns.
func (s *Service) handleWS(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	c, err := websocket.Accept(w, r, nil)
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
		wctx, wcancel := context.WithTimeout(ctx, wsWriteTimeout)
		defer wcancel()
		return c.Write(wctx, websocket.MessageText, raw)
	}

	for {
		_, raw, err := c.Read(ctx)
		if err != nil {
			return // client went away or socket closed
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
			// Persist the user turn BEFORE the model runs (fail-open chat
			// history: a lost assistant reply is a transcript gap, never a
			// lost user intent).
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
