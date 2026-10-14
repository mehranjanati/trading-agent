// AI delegation: the Worker plane owns the AI binding. This client posts the
// assembled history to {base}/api/strategy:chat:stream and consumes the SSE.
package chat

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// AIClient talks to the Worker chat:stream endpoint.
type AIClient struct {
	Base string // Workers URL (no trailing slash)
	Role string // x-role header (trader)
	HTTP *http.Client
}

// NewAIClient builds the streaming AI client.
func NewAIClient(base string) *AIClient {
	return &AIClient{Base: strings.TrimRight(base, "/"), Role: "trader", HTTP: &http.Client{Timeout: sseReadTimeout}}
}

// StreamResult is one full AI turn.
type StreamResult struct {
	Text       string
	CodeBlocks []CodeBlock
	Model      string
}

// aiRequest is the POST body for the Worker chat:stream route.
type aiRequest struct {
	SessionID  string      `json:"session_id,omitempty"`
	Messages   []aiMessage `json:"messages"`
	Principles string      `json:"principles,omitempty"`
}

// aiMessage is one turn on the wire to the Worker. Content is `any` because a
// turn carrying a chart image must serialize as an OpenAI content-part array
// ([{type:"text"},{type:"image_url"}]) while a plain turn stays a string.
type aiMessage struct {
	ID      string `json:"id,omitempty"`
	Role    string `json:"role"`
	Content any    `json:"content"`
}

// aiPart is one OpenAI/Qwen multimodal content part. The deprecated top-level
// `image` parameter is deliberately unused: an image must ride a `user` turn as
// a part (system/assistant turns cannot carry one).
type aiPart struct {
	Type     string   `json:"type"`
	Text     string   `json:"text,omitempty"`
	ImageURL *aiImage `json:"image_url,omitempty"`
}

// aiImage is the image_url payload: a base64 data URL plus the detail hint.
type aiImage struct {
	URL    string `json:"url"`
	Detail string `json:"detail,omitempty"`
}

// assembleAIMessages renders the window for the model. Image bytes ride only on
// the newest maxImageTurns image-bearing turns (cost control — one chart is
// ≈1400 prompt tokens); older charts become a text marker the model already saw.
func assembleAIMessages(window []Message) []aiMessage {
	keepImage := make([]bool, len(window))
	seen := 0
	for i := len(window) - 1; i >= 0; i-- {
		if len(window[i].Attachments) == 0 {
			continue
		}
		if seen < maxImageTurns {
			keepImage[i] = true
			seen++
		}
	}
	out := make([]aiMessage, 0, len(window))
	for i, m := range window {
		if len(m.Attachments) == 0 {
			out = append(out, aiMessage{ID: m.ID, Role: m.Role, Content: m.Content})
			continue
		}
		parts := []aiPart{{Type: "text", Text: m.Content}}
		inline := false
		for _, a := range m.Attachments {
			if !keepImage[i] || a.DataURL == "" {
				continue
			}
			parts = append(parts, aiPart{Type: "image_url", ImageURL: &aiImage{URL: a.DataURL, Detail: a.Detail}})
			inline = true
		}
		if inline {
			out = append(out, aiMessage{ID: m.ID, Role: m.Role, Content: parts})
			continue
		}
		// Bytes withheld: keep the transcript coherent with a marker.
		out = append(out, aiMessage{ID: m.ID, Role: m.Role, Content: strings.TrimSpace(m.Content + "\n[chart image attached earlier]")})
	}
	return out
}

// Stream posts the history and consumes the SSE stream, calling onChunk for
// every delta. The final assembled text + code blocks are returned. sessionID
// rides along so the Worker can key the R2/D1 chart attachment row.
func (c *AIClient) Stream(ctx context.Context, sessionID string, msgs []Message, principles string, onChunk func(string)) (StreamResult, error) {
	body, err := json.Marshal(aiRequest{SessionID: sessionID, Messages: assembleAIMessages(msgs), Principles: principles})
	if err != nil {
		return StreamResult{}, fmt.Errorf("chat: ai marshal: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.Base+"/api/strategy:chat:stream", bytes.NewReader(body))
	if err != nil {
		return StreamResult{}, err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("accept", "text/event-stream")
	req.Header.Set("x-role", c.Role)
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return StreamResult{}, fmt.Errorf("chat: ai post: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return StreamResult{}, fmt.Errorf("chat: ai status %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}

	var sb strings.Builder
	model := resp.Header.Get("x-ai-model") // Worker reports the model it ran
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		line := sc.Text()
		// SSE comments/keep-alives are skipped by parseSSEFrame.
		if strings.HasPrefix(line, ":") {
			continue
		}
		text, done, ok := parseSSEFrame(line)
		if done {
			break
		}
		if model == "" {
			model = frameModel(line) // no x-ai-model header: read it off the frames
		}
		if !ok || text == "" {
			continue
		}
		sb.WriteString(text)
		if onChunk != nil {
			onChunk(text)
		}
	}
	if err := sc.Err(); err != nil && ctx.Err() == nil {
		return StreamResult{}, fmt.Errorf("chat: ai stream: %w", err)
	}
	full := sb.String()
	return StreamResult{Text: full, CodeBlocks: extractCodeBlocks(full), Model: model}, nil
}
