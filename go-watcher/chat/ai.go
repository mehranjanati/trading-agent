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
	Messages   []Message `json:"messages"`
	Principles string    `json:"principles,omitempty"`
}

// Stream posts the history and consumes the SSE stream, calling onChunk for
// every delta. The final assembled text + code blocks are returned.
func (c *AIClient) Stream(ctx context.Context, msgs []Message, principles string, onChunk func(string)) (StreamResult, error) {
	body, err := json.Marshal(aiRequest{Messages: msgs, Principles: principles})
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
