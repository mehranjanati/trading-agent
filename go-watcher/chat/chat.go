// Package chat — multi-turn chat service (v2-vibe pattern, trading-scoped).
//
// Responsibilities:
//   - Sessions in Redis: messages list + meta hash, 24h TTL, cross-device.
//   - Context window management: principles always first; sliding window by
//     estimated tokens so the assembled history fits the model's 32K budget.
//   - AI delegation: the Worker plane owns the AI binding (no keys in Go);
//     this service posts the assembled history to
//     {WORKERS_URL}/api/strategy:chat:stream and consumes the model's SSE.
//   - Transport: HTTP for history/create + WebSocket for real-time — a user
//     message arrives on WS, chunks stream back as {"type":"chunk"} events,
//     a final {"type":"done"} event carries code blocks and stores both
//     messages in Redis.
//
// Safety: chat is ADVISORY ONLY. It never touches watches, orders,
// approvals or kill-switch state; its only writes are its own Redis keys.
package chat

import (
	"encoding/json"
	"strings"
	"time"
)

// Model context budget (qwen3-30b-a3b-fp8 = 32K tokens). The window keeps
// the assembled history under it with headroom for the response.
const (
	maxContextTokens = 24000
	msgTTL           = 24 * time.Hour
	sseReadTimeout   = 120 * time.Second
	wsWriteTimeout   = 30 * time.Second
)

// Message is one stored conversation turn.
type Message struct {
	Role      string `json:"role"`
	Content   string `json:"content"`
	Timestamp string `json:"timestamp"`
}

// CodeBlock is one fenced block extracted from an assistant reply.
type CodeBlock struct {
	Language string `json:"language"`
	Code     string `json:"code"`
}

// ChatEvent is the WebSocket wire envelope (server → client).
type ChatEvent struct {
	Type       string      `json:"type"` // "chunk" | "done" | "error" | "history" | "principles"
	Text       string      `json:"text,omitempty"`
	CodeBlocks []CodeBlock `json:"codeBlocks,omitempty"`
	Model      string      `json:"model,omitempty"`
	Error      string      `json:"error,omitempty"`
}

// estimateTokens is a cheap heuristic (~4 chars/token); the window is a
// budget, not an exact count — the model tolerates ±10%.
func estimateTokens(s string) int { return len(s) / 4 }

// ApplyWindow enforces the context budget: keep principles (they are policy)
// and the newest messages that fit; never emit an empty history.
func ApplyWindow(msgs []Message, principles string) []Message {
	budget := maxContextTokens - estimateTokens(principles) - 512
	total := 0
	keep := 0
	for i := len(msgs) - 1; i >= 0; i-- {
		total += estimateTokens(msgs[i].Content)
		if total > budget {
			break
		}
		keep++
	}
	if keep == 0 && len(msgs) > 0 {
		keep = 1 // never return an empty window
	}
	return msgs[len(msgs)-keep:]
}

// extractCodeBlocks finds all fenced blocks (any language) in text — mirrors
// the Worker's extractCodeBlocks so both sides agree on the wire shape.
func extractCodeBlocks(text string) []CodeBlock {
	blocks := []CodeBlock{}
	for i := 0; i < len(text); {
		open := strings.Index(text[i:], "```")
		if open < 0 {
			break
		}
		start := i + open + 3
		nl := strings.Index(text[start:], "\n")
		if nl < 0 {
			break
		}
		lang := strings.TrimSpace(text[start : start+nl])
		rest := text[start+nl+1:]
		close := strings.Index(rest, "```")
		if close < 0 {
			break
		}
		blocks = append(blocks, CodeBlock{Language: lang, Code: strings.TrimSpace(rest[:close])})
		i = start + nl + 1 + close + 3
	}
	return blocks
}

// sseEvent is one parsed SSE data frame from the model stream. Workers AI
// emits OpenAI-compatible chat chunks with a top-level `response` mirror
// field; older/simple models use `result`. `delta.reasoning` is
// chain-of-thought and is deliberately NEVER surfaced.
type sseEvent struct {
	Response json.RawMessage `json:"response"`
	Result   json.RawMessage `json:"result"`
	Model    string          `json:"model"`
	Choices  []struct {
		Delta struct {
			Content string `json:"content"`
		} `json:"delta"`
	} `json:"choices"`
}

// Response/Result are RawMessage, not string: the mirror field echoes
// delta.content verbatim, so a numeric answer arrives as JSON `2` and a typed
// string field would fail the whole frame's unmarshal -- silently degrading the
// stream into raw JSON echoed at the user.
// parseSSEFrame extracts the delta text from one `data: ...` line. Returns
// ("", false) for keep-alives/comments; done=true marks the [DONE] sentinel.
func parseSSEFrame(line string) (text string, done bool, ok bool) {
	line = strings.TrimSpace(line)
	if !strings.HasPrefix(line, "data:") {
		return "", false, false
	}
	payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
	if payload == "" || payload == "[DONE]" {
		return "", payload == "[DONE]", false
	}
	var ev sseEvent
	if err := json.Unmarshal([]byte(payload), &ev); err != nil {
		return payload, false, true // tolerate non-JSON deltas as raw text
	}
	if t := rawText(ev.Response); t != "" {
		return t, false, true
	}
	if len(ev.Choices) > 0 && ev.Choices[0].Delta.Content != "" {
		return ev.Choices[0].Delta.Content, false, true
	}
	if t := rawText(ev.Result); t != "" {
		return t, false, true
	}
	return "", false, false
}

// frameModel extracts the model name carried on an SSE frame ("" if absent).
// It is the fallback when the proxy does not set x-ai-model.
func frameModel(line string) string {
	line = strings.TrimSpace(line)
	if !strings.HasPrefix(line, "data:") {
		return ""
	}
	payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
	var ev sseEvent
	if json.Unmarshal([]byte(payload), &ev) != nil {
		return ""
	}
	return ev.Model
}

// rawText renders a raw JSON scalar field as plain text: strings lose their
// quotes, other scalars keep their literal form, null/absent is "".
func rawText(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	return strings.TrimSpace(string(raw))
}
