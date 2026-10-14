package chat

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// ── ApplyWindow ─────────────────────────────────────────────────────────────

func msg(role, content string) Message {
	return Message{Role: role, Content: content, Timestamp: "2026-10-13T00:00:00Z"}
}

func TestApplyWindowKeepsAllWhenSmall(t *testing.T) {
	msgs := []Message{msg("user", "hi"), msg("assistant", "hello")}
	got := ApplyWindow(msgs, "Max risk 2%")
	if len(got) != 2 {
		t.Fatalf("small history must survive intact, got %d", len(got))
	}
	if got[0].Content != "hi" {
		t.Fatalf("oldest must come first, got %q", got[0].Content)
	}
}

func TestApplyWindowPrunesOldestFirst(t *testing.T) {
	big := strings.Repeat("x", 40000) // 10k estimated tokens each
	msgs := []Message{msg("user", "OLDEST "+big)}
	for i := 0; i < 4; i++ {
		msgs = append(msgs, msg("assistant", fmt.Sprintf("m%d %s", i, big)))
	}
	got := ApplyWindow(msgs, "")
	if len(got) >= len(msgs) {
		t.Fatalf("expected pruning, kept %d of %d", len(got), len(msgs))
	}
	if strings.HasPrefix(got[len(got)-1].Content, "m3") == false {
		t.Fatalf("newest message must be kept, got %q", got[len(got)-1].Content[:8])
	}
	if strings.HasPrefix(got[0].Content, "OLDEST") {
		t.Fatal("window must drop from the OLDEST end")
	}
}

func TestApplyWindowNeverEmpty(t *testing.T) {
	huge := strings.Repeat("y", maxContextTokens*8) // single message over budget
	got := ApplyWindow([]Message{msg("user", huge)}, "")
	if len(got) != 1 {
		t.Fatalf("window must keep at least the newest message, got %d", len(got))
	}
}

func TestApplyWindowReservesPrinciples(t *testing.T) {
	// A giant principles block shrinks the budget: fewer messages survive than
	// with no principles at all.
	big := strings.Repeat("z", 20000)
	msgs := []Message{msg("user", big), msg("assistant", big), msg("user", big)}
	few := ApplyWindow(msgs, strings.Repeat("p", 4000))
	many := ApplyWindow(msgs, "")
	if len(few) > len(many) {
		t.Fatalf("principles must reduce the window: %d > %d", len(few), len(many))
	}
}

// ── extractCodeBlocks ───────────────────────────────────────────────────────

func TestExtractCodeBlocksMultiple(t *testing.T) {
	text := "intro\n```go\npackage main\n```\nmid\n```json\n{\"a\":1}\n```\nend"
	blocks := extractCodeBlocks(text)
	if len(blocks) != 2 {
		t.Fatalf("want 2 blocks, got %d", len(blocks))
	}
	if blocks[0].Language != "go" || blocks[0].Code != "package main" {
		t.Fatalf("bad first block: %+v", blocks[0])
	}
	if blocks[1].Language != "json" || blocks[1].Code != `{"a":1}` {
		t.Fatalf("bad second block: %+v", blocks[1])
	}
}

func TestExtractCodeBlocksNone(t *testing.T) {
	if got := extractCodeBlocks("plain prose, no fences"); len(got) != 0 {
		t.Fatalf("want 0 blocks, got %d", len(got))
	}
}

func TestExtractCodeBlocksUnterminatedIgnored(t *testing.T) {
	// A dangling fence (stream cut) must not yield a half block.
	if got := extractCodeBlocks("```go\npackage main"); len(got) != 0 {
		t.Fatalf("unterminated fence must be ignored, got %d", len(got))
	}
}

func TestExtractCodeBlocksNoLanguage(t *testing.T) {
	blocks := extractCodeBlocks("```\nfoo\n```")
	if len(blocks) != 1 || blocks[0].Language != "" || blocks[0].Code != "foo" {
		t.Fatalf("language-less fence mishandled: %+v", blocks)
	}
}

// ── parseSSEFrame ───────────────────────────────────────────────────────────

func TestParseSSEFrameDelta(t *testing.T) {
	text, done, ok := parseSSEFrame(`data: {"response":"chunk"}`)
	if !ok || done || text != "chunk" {
		t.Fatalf("delta frame wrong: %q %v %v", text, done, ok)
	}
}

func TestParseSSEFrameDone(t *testing.T) {
	_, done, _ := parseSSEFrame("data: [DONE]")
	if !done {
		t.Fatal("[DONE] sentinel must set done")
	}
}

func TestParseSSEFrameSkipsNoise(t *testing.T) {
	for _, line := range []string{"", ":keep-alive", "event: foo", "data:", "data: {}"} {
		if _, _, ok := parseSSEFrame(line); ok {
			t.Fatalf("%q must be skipped", line)
		}
	}
}

func TestParseSSEFrameRawFallback(t *testing.T) {
	text, _, ok := parseSSEFrame("data: not json at all")
	if !ok || text != "not json at all" {
		t.Fatalf("non-JSON payload must pass through: %q %v", text, ok)
	}
}

// ── AIClient.Stream against a fake Workers SSE endpoint ─────────────────────

func TestStreamAssemblesChunksAndModel(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/strategy:chat:stream" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		if r.Method != http.MethodPost || r.Header.Get("x-role") != "trader" {
			t.Errorf("bad request: %s x-role=%q", r.Method, r.Header.Get("x-role"))
		}
		w.Header().Set("content-type", "text/event-stream")
		w.Header().Set("x-ai-model", "@cf/qwen/qwen3-30b-a3b-fp8")
		fmt.Fprint(w, ": ping\n\n")
		fmt.Fprint(w, "data: {\"response\":\"Here \"}\n\n")
		fmt.Fprint(w, "data: {\"response\":\"is \\u0060\\u0060\\u0060go\\npackage main\\n\\u0060\\u0060\\u0060\"}\n\n")
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer srv.Close()

	c := NewAIClient(srv.URL)
	var chunks []string
	res, err := c.Stream(context.Background(), []Message{msg("user", "write a strategy")}, "Max risk 2%", func(s string) {
		chunks = append(chunks, s)
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(chunks) != 2 {
		t.Fatalf("onChunk must fire per delta, got %d", len(chunks))
	}
	if !strings.Contains(res.Text, "package main") {
		t.Fatalf("assembled text wrong: %q", res.Text)
	}
	if len(res.CodeBlocks) != 1 || res.CodeBlocks[0].Code != "package main" {
		t.Fatalf("code blocks wrong: %+v", res.CodeBlocks)
	}
	if res.Model != "@cf/qwen/qwen3-30b-a3b-fp8" {
		t.Fatalf("model header not captured: %q", res.Model)
	}
}

func TestStreamSurfacesWorkerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprint(w, `{"code":"VALIDATION","message":"messages array required (min 1)"}`)
	}))
	defer srv.Close()
	_, err := NewAIClient(srv.URL).Stream(context.Background(), nil, "", nil)
	if err == nil || !strings.Contains(err.Error(), "400") {
		t.Fatalf("worker error must surface, got %v", err)
	}
}

// ── real Workers AI chunk shape (OpenAI-compatible) ─────────────────────────
//
// Captured live from the deployed Worker: every frame is a full chat chunk,
// text rides on choices[0].delta.content, chain-of-thought rides on
// delta.reasoning, and the top-level `response` mirror is usually empty.

func TestParseSSEFrameOpenAIChunk(t *testing.T) {
	line := `data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"content":"PING"},"finish_reason":null}]}`
	text, done, ok := parseSSEFrame(line)
	if !ok || done || text != "PING" {
		t.Fatalf("delta.content not extracted: %q done=%v ok=%v", text, done, ok)
	}
}

func TestParseSSEFrameReasoningIgnored(t *testing.T) {
	// Chain-of-thought must never reach the user transcript.
	line := `data: {"choices":[{"index":0,"delta":{"reasoning":"secret thoughts","reasoning_content":"more"}}]}`
	text, _, ok := parseSSEFrame(line)
	if ok || text != "" {
		t.Fatalf("reasoning must be skipped, got %q ok=%v", text, ok)
	}
}

func TestParseSSEFrameRoleOnlyFrameSkipped(t *testing.T) {
	line := `data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""}}],"response":""}`
	if _, _, ok := parseSSEFrame(line); ok {
		t.Fatal("empty role frame must be skipped")
	}
}

func TestFrameModel(t *testing.T) {
	line := `data: {"model":"@cf/qwen/qwen3-30b-a3b-fp8","choices":[{"delta":{"content":"x"}}]}`
	if got := frameModel(line); got != "@cf/qwen/qwen3-30b-a3b-fp8" {
		t.Fatalf("model not read from frame: %q", got)
	}
	if got := frameModel(": keepalive"); got != "" {
		t.Fatalf("comment line must yield no model, got %q", got)
	}
}

func TestStreamRealChunkShapeWithoutHeader(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, "data: {\"model\":\"@cf/qwen/qwen3-30b-a3b-fp8\",\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"\"}}]}\n\n")
		fmt.Fprint(w, "data: {\"model\":\"@cf/qwen/qwen3-30b-a3b-fp8\",\"choices\":[{\"delta\":{\"reasoning\":\"hmm let me think\"}}]}\n\n")
		fmt.Fprint(w, "data: {\"model\":\"@cf/qwen/qwen3-30b-a3b-fp8\",\"choices\":[{\"delta\":{\"content\":\"Here is \"}}]}\n\n")
		fmt.Fprint(w, "data: {\"model\":\"@cf/qwen/qwen3-30b-a3b-fp8\",\"choices\":[{\"delta\":{\"content\":\"done.\"}}]}\n\n")
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer srv.Close()
	res, err := NewAIClient(srv.URL).Stream(context.Background(), []Message{msg("user", "go")}, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(res.Text, "let me think") {
		t.Fatalf("reasoning leaked into the transcript: %q", res.Text)
	}
	if !strings.Contains(res.Text, "Here is ") {
		t.Fatalf("content lost: %q", res.Text)
	}
	if res.Model != "@cf/qwen/qwen3-30b-a3b-fp8" {
		t.Fatalf("model must come from frames when the header is absent: %q", res.Model)
	}
}

// A streamed code fence must assemble into a block across chunk boundaries.
func TestStreamCodeFenceAcrossChunks(t *testing.T) {
	fence := "```go\npackage main\n```"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		for _, part := range []string{"intro ", fence[:6], fence[6:12], fence[12:], " tail"} {
			fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"content\":%q}}]}\n\n", part)
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer srv.Close()
	res, err := NewAIClient(srv.URL).Stream(context.Background(), []Message{msg("user", "go")}, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.CodeBlocks) != 1 || res.CodeBlocks[0].Language != "go" || res.CodeBlocks[0].Code != "package main" {
		t.Fatalf("split fence not reassembled: %+v text=%q", res.CodeBlocks, res.Text)
	}
}

// ── ServeHTTP routing + CORS + WS origin gate ───────────────────────────────

// nilStore keeps the HTTP routing tests off Redis: a store that fails every op
// still proves the router reached the right handler (502, not 404).
type nilStore struct{}

func (nilStore) Create(string, string) error        { return nil }
func (nilStore) Append(string, Message) error       { return errStore }
func (nilStore) Messages(string) ([]Message, error) { return nil, errStore }
func (nilStore) Principles(string) (string, error)  { return "", errStore }
func (nilStore) SetPrinciples(string, string) error { return errStore }
func (nilStore) Delete(string) error                { return errStore }

var errStore = fmt.Errorf("no redis")

func newSvc(origins ...string) *Service {
	return &Service{Store: nilStore{}, AI: nil, Origins: origins}
}

func TestRoutePreflightReturns204(t *testing.T) {
	req := httptest.NewRequest(http.MethodOptions, "/api/chat/create", nil)
	rec := httptest.NewRecorder()
	newSvc().ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("OPTIONS preflight must be 204, got %d", rec.Code)
	}
	if rec.Header().Get("access-control-allow-origin") != "*" {
		t.Fatal("preflight must advertise allow-origin")
	}
	if rec.Header().Get("access-control-allow-methods") == "" {
		t.Fatal("preflight must advertise allow-methods")
	}
}

func TestRouteCreateReturns201(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/chat/create", strings.NewReader(`{"principles":"x"}`))
	rec := httptest.NewRecorder()
	newSvc().ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create must be 201, got %d", rec.Code)
	}
}

func TestRouteGetDeleteReachStore(t *testing.T) {
	// errStore proves dispatch happened: a router miss would answer 404.
	for _, m := range []string{http.MethodGet, http.MethodDelete} {
		req := httptest.NewRequest(m, "/api/chat/chat_1_abc", nil)
		rec := httptest.NewRecorder()
		newSvc().ServeHTTP(rec, req)
		if rec.Code != http.StatusBadGateway {
			t.Fatalf("%s /api/chat/{id} must reach the store (502), got %d", m, rec.Code)
		}
	}
}

func TestRoutePrinciplesReachesStore(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/chat/chat_1_abc/principles", strings.NewReader(`{"content":"p"}`))
	rec := httptest.NewRecorder()
	newSvc().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("principles must reach the store (502), got %d", rec.Code)
	}
}

func TestRouteUnknownPathsAre404(t *testing.T) {
	for _, p := range []string{"/", "/api/chat", "/api/chat/", "/nope", "/api/chat/a/b/c"} {
		req := httptest.NewRequest(http.MethodGet, p, nil)
		rec := httptest.NewRecorder()
		newSvc().ServeHTTP(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s must be 404, got %d", p, rec.Code)
		}
	}
}

func TestRouteWSPathIsDispatchedNot404(t *testing.T) {
	// websocket.Accept rejects a non-upgrade request with 400 (it writes the
	// 426/400 itself), which is still proof the router reached handleWS.
	req := httptest.NewRequest(http.MethodGet, "/ws/chat/chat_1_abc", nil)
	rec := httptest.NewRecorder()
	newSvc().ServeHTTP(rec, req)
	if rec.Code == http.StatusNotFound {
		t.Fatal("/ws/chat/{id} must be routed to handleWS, got 404")
	}
}

func TestWSOriginAllowListRejectsForeignOrigin(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/ws/chat/chat_1_abc", nil)
	req.Header.Set("Origin", "https://evil.example")
	rec := httptest.NewRecorder()
	newSvc("https://dash.example").ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("foreign Origin must be 403, got %d", rec.Code)
	}
}

func TestWSOriginAllowListAcceptsListedOrigin(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/ws/chat/chat_1_abc", nil)
	req.Header.Set("Origin", "https://dash.example")
	rec := httptest.NewRecorder()
	newSvc("https://dash.example").ServeHTTP(rec, req)
	if rec.Code == http.StatusForbidden {
		t.Fatal("listed Origin must pass the gate")
	}
}

func TestWSNoAllowListAcceptsAnyOrigin(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/ws/chat/chat_1_abc", nil)
	req.Header.Set("Origin", "https://anything.example")
	rec := httptest.NewRecorder()
	newSvc().ServeHTTP(rec, req)
	if rec.Code == http.StatusForbidden {
		t.Fatal("empty allow-list must accept any Origin (local dev)")
	}
}

func TestOriginAllowed(t *testing.T) {
	if !originAllowed("https://a", []string{"https://a", "https://b"}) {
		t.Fatal("exact match must be allowed")
	}
	if originAllowed("https://a.evil", []string{"https://a"}) {
		t.Fatal("prefix is not a match — no wildcard expansion")
	}
	if originAllowed("https://c", []string{"https://a"}) {
		t.Fatal("unlisted origin must be rejected")
	}
}

func TestRouteCreateBodyIsExact(t *testing.T) {
	// The 201 body must be the only thing on the wire: a handler that falls
	// through to http.NotFound appends "404 page not found" and corrupts the
	// JSON the dashboard parses.
	req := httptest.NewRequest(http.MethodPost, "/api/chat/create", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()
	newSvc().ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create must be 201, got %d", rec.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body must be pure JSON, got %q: %v", rec.Body.String(), err)
	}
	id, _ := body["id"].(string)
	if id == "" {
		t.Fatal("create must return the new session id")
	}
}

// idStore records the id each handler actually received, proving the router's
// context value survives into the handler (r.PathValue cannot see it).
type idStore struct{ got []string }

func (s *idStore) Create(id, _ string) error          { s.got = append(s.got, id); return nil }
func (s *idStore) Append(id string, _ Message) error  { s.got = append(s.got, id); return nil }
func (s *idStore) Messages(string) ([]Message, error) { return nil, nil }
func (s *idStore) Principles(id string) (string, error) {
	s.got = append(s.got, id)
	return "P", nil
}
func (s *idStore) SetPrinciples(id, _ string) error { s.got = append(s.got, id); return nil }
func (s *idStore) Delete(id string) error           { s.got = append(s.got, id); return nil }

func TestHandlersReceiveRoutedID(t *testing.T) {
	const want = "chat_1_abc"
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/chat/" + want},
		{http.MethodDelete, "/api/chat/" + want},
	} {
		st := &idStore{}
		req := httptest.NewRequest(tc.method, tc.path, nil)
		svc := &Service{Store: st}
		svc.ServeHTTP(httptest.NewRecorder(), req)
		if len(st.got) != 1 || st.got[0] != want {
			t.Fatalf("%s %s: handler got %v, want [%s]", tc.method, tc.path, st.got, want)
		}
	}
}

func TestHandleGetReturnsPrinciples(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/chat/chat_1_abc", nil)
	rec := httptest.NewRecorder()
	svc := &Service{Store: &idStore{}}
	svc.ServeHTTP(rec, req)
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("bad JSON %q: %v", rec.Body.String(), err)
	}
	if body["principles"] != "P" {
		t.Fatalf("principles must round-trip from the store, got %v", body["principles"])
	}
}

// ── SSE mirror-field typing ─────────────────────────────────────────────────

func TestParseSSEFrameNumericResponseMirror(t *testing.T) {
	// Workers AI mirrors delta.content into a top-level `response` field with
	// the SAME JSON type, so "2" arrives as the number 2. A string-typed field
	// fails the frame unmarshal and the raw JSON leaks to the user.
	got, done, ok := parseSSEFrame(`data: {"response":2,"choices":[{"delta":{"content":"2"}}]}`)
	if done || !ok {
		t.Fatalf("frame must parse, got done=%v ok=%v text=%q", done, ok, got)
	}
	if got != "2" {
		t.Fatalf("numeric mirror must yield 2, got %q", got)
	}
}

func TestParseSSEFrameStringResponseMirror(t *testing.T) {
	got, _, ok := parseSSEFrame(`data: {"response":"hi"}`)
	if !ok || got != "hi" {
		t.Fatalf("string mirror must yield hi unquoted, got ok=%v %q", ok, got)
	}
}

func TestParseSSEFrameNullResponseFallsThrough(t *testing.T) {
	// A null mirror is not text; the content delta still wins.
	got, _, ok := parseSSEFrame(`data: {"response":null,"choices":[{"delta":{"content":"ok"}}]}`)
	if !ok || got != "ok" {
		t.Fatalf("null mirror must fall through to content, got ok=%v %q", ok, got)
	}
}

func TestParseSSEFrameNeverSurfacesReasoning(t *testing.T) {
	for _, frame := range []string{
		`data: {"choices":[{"delta":{"reasoning":"thinking hard"}}]}`,
		`data: {"choices":[{"delta":{"reasoning":"a","reasoning_content":"b"}}]}`,
		`data: {"response":null,"choices":[{"delta":{"reasoning":"a"}}]}`,
	} {
		got, done, ok := parseSSEFrame(frame)
		if ok || done || got != "" {
			t.Fatalf("reasoning-only frame must yield nothing, got ok=%v done=%v %q (%s)", ok, done, got, frame)
		}
	}
}

func TestParseSSEFrameSentinelAndNoise(t *testing.T) {
	if _, done, _ := parseSSEFrame("data: [DONE]"); !done {
		t.Fatal("[DONE] must mark the end")
	}
	for _, noise := range []string{":keep-alive", "", "event: ping", "id: 1"} {
		if _, done, ok := parseSSEFrame(noise); done || ok {
			t.Fatalf("%q must be ignored, got done=%v ok=%v", noise, done, ok)
		}
	}
}
