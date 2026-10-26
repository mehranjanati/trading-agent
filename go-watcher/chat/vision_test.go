package chat

import (
	"encoding/json"
	"strings"
	"testing"
)

// tinyPNG is a real 1x1 PNG data URL (70 decoded bytes).
const tinyPNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

func chartMsg(id, text string) Message {
	return Message{ID: id, Role: "user", Content: text,
		Attachments: []Attachment{{MediaType: "image/png", DataURL: tinyPNG, Detail: "low"}}}
}

// ── wsIn -> Message (the WS boundary) ───────────────────────────────────────

func TestBuildUserMessageAcceptsChart(t *testing.T) {
	m, verr := buildUserMessage(wsIn{Type: "message", ID: "u1", Content: "what is this?",
		Image: &wsImage{MediaType: "image/png", DataURL: tinyPNG}})
	if verr != "" {
		t.Fatalf("valid chart turn rejected: %s", verr)
	}
	if m.ID != "u1" || m.Role != "user" || m.Content != "what is this?" {
		t.Fatalf("bad message: %+v", m)
	}
	if len(m.Attachments) != 1 || m.Attachments[0].MediaType != "image/png" || m.Attachments[0].Detail != "low" {
		t.Fatalf("bad attachment: %+v", m.Attachments)
	}
}

func TestBuildUserMessageGeneratesIDAndDefaultText(t *testing.T) {
	m, verr := buildUserMessage(wsIn{Type: "message", Image: &wsImage{MediaType: "image/jpeg", DataURL: "data:image/jpeg;base64,AAAA"}})
	if verr != "" {
		t.Fatalf("chart-only turn rejected: %s", verr)
	}
	if !strings.HasPrefix(m.ID, "msg_") {
		t.Fatalf("id must be minted when the client omits one, got %q", m.ID)
	}
	if m.Content == "" {
		t.Fatal("an image-only turn needs a default prompt")
	}
}

func TestBuildUserMessageRejectsBadImages(t *testing.T) {
	cases := []struct {
		name string
		in   wsIn
	}{
		{"unsupported type", wsIn{Image: &wsImage{MediaType: "image/gif", DataURL: "data:image/gif;base64,R0lGOD"}}},
		{"type/url mismatch", wsIn{Image: &wsImage{MediaType: "image/png", DataURL: "data:image/jpeg;base64,AAAA"}}},
		{"oversized", wsIn{Image: &wsImage{MediaType: "image/png", DataURL: "data:image/png;base64," + strings.Repeat("A", maxImageDataURL)}}},
		{"bad image inside the array", wsIn{Images: []wsImage{
			{MediaType: "image/png", DataURL: tinyPNG},
			{MediaType: "image/gif", DataURL: "data:image/gif;base64,R0lGOD"},
		}}},
		{"over the per-turn cap", wsIn{Images: []wsImage(
			func() []wsImage {
				out := make([]wsImage, maxImagesPerTurn+1)
				for i := range out {
					out[i] = wsImage{MediaType: "image/png", DataURL: tinyPNG}
				}
				return out
			}(),
		)}},
	}
	for _, tc := range cases {
		tc.in.Type = "message"
		if _, verr := buildUserMessage(tc.in); verr == "" {
			t.Fatalf("%s must be rejected", tc.name)
		}
	}
}

func TestBuildUserMessageAcceptsMultipleImages(t *testing.T) {
	in := wsIn{Type: "message", ID: "u1", Content: "compare these two",
		Images: []wsImage{
			{MediaType: "image/png", DataURL: tinyPNG},
			{MediaType: "image/jpeg", DataURL: "data:image/jpeg;base64,AAAA", Detail: "high"},
		}}
	m, verr := buildUserMessage(in)
	if verr != "" {
		t.Fatalf("multi-chart turn rejected: %s", verr)
	}
	if len(m.Attachments) != 2 {
		t.Fatalf("want 2 attachments, got %+v", m.Attachments)
	}
	if m.Attachments[0].DataURL != tinyPNG || m.Attachments[0].Detail != "low" {
		t.Fatalf("first attachment wrong: %+v", m.Attachments[0])
	}
	if m.Attachments[1].MediaType != "image/jpeg" || m.Attachments[1].Detail != "high" {
		t.Fatalf("second attachment wrong: %+v", m.Attachments[1])
	}
}

func TestBuildUserMessageLegacyImageStaysAccepted(t *testing.T) {
	// The pre-multi deploy sends `image`; both envelopes must land identically.
	legacy, verr := buildUserMessage(wsIn{Type: "message", Content: "look",
		Image: &wsImage{MediaType: "image/png", DataURL: tinyPNG}})
	if verr != "" {
		t.Fatalf("legacy envelope rejected: %s", verr)
	}
	multi, verr := buildUserMessage(wsIn{Type: "message", Content: "look",
		Images: []wsImage{{MediaType: "image/png", DataURL: tinyPNG}}})
	if verr != "" {
		t.Fatalf("multi envelope rejected: %s", verr)
	}
	if len(legacy.Attachments) != 1 || len(multi.Attachments) != 1 ||
		legacy.Attachments[0].DataURL != multi.Attachments[0].DataURL {
		t.Fatalf("envelopes must agree: %+v vs %+v", legacy.Attachments, multi.Attachments)
	}
}

func TestBuildUserMessageMultiDefaultText(t *testing.T) {
	m, verr := buildUserMessage(wsIn{Type: "message", Images: []wsImage{
		{MediaType: "image/png", DataURL: tinyPNG},
		{MediaType: "image/png", DataURL: tinyPNG},
	}})
	if verr != "" {
		t.Fatalf("rejected: %s", verr)
	}
	if !strings.Contains(m.Content, "2 attached charts") {
		t.Fatalf("multi-chart default prompt wrong: %q", m.Content)
	}
}

func TestAssembleAIMessagesInlinesEveryAttachmentOfOneTurn(t *testing.T) {
	m := Message{ID: "u1", Role: "user", Content: "two charts", Attachments: []Attachment{
		{MediaType: "image/png", DataURL: tinyPNG, Detail: "low"},
		{MediaType: "image/png", DataURL: tinyPNG, Detail: "low"},
	}}
	parts, ok := assembleAIMessages([]Message{m})[0].Content.([]aiPart)
	if !ok {
		t.Fatal("charted turn must become parts")
	}
	images := 0
	for _, p := range parts {
		if p.Type == "image_url" {
			images++
		}
	}
	if images != 2 {
		t.Fatalf("every attachment must become its own image_url part, got %d", images)
	}
}

// ── assembleAIMessages (cost-bounded multimodal assembly) ───────────────────

func TestAssembleAIMessagesTextOnlyStaysString(t *testing.T) {
	got := assembleAIMessages([]Message{msg("user", "hi"), msg("assistant", "yo")})
	if len(got) != 2 {
		t.Fatalf("want 2, got %d", len(got))
	}
	if s, ok := got[0].Content.(string); !ok || s != "hi" {
		t.Fatalf("text turn must stay a string, got %#v", got[0].Content)
	}
}

func TestAssembleAIMessagesImageBecomesParts(t *testing.T) {
	got := assembleAIMessages([]Message{chartMsg("u1", "read this")})
	parts, ok := got[0].Content.([]aiPart)
	if !ok {
		t.Fatalf("chart turn must become parts, got %#v", got[0].Content)
	}
	if len(parts) != 2 || parts[0].Type != "text" || parts[1].Type != "image_url" {
		t.Fatalf("bad parts: %+v", parts)
	}
	if parts[1].ImageURL.URL != tinyPNG || parts[1].ImageURL.Detail != "low" {
		t.Fatalf("bad image part: %+v", parts[1].ImageURL)
	}
	if got[0].ID != "u1" {
		t.Fatalf("message id must ride along, got %q", got[0].ID)
	}
}

func TestAssembleAIMessagesKeepsOnlyNewestImageTurns(t *testing.T) {
	window := []Message{
		chartMsg("u1", "old chart"), msg("assistant", "a1"),
		chartMsg("u2", "mid chart"), msg("assistant", "a2"),
		chartMsg("u3", "new chart"),
	}
	got := assembleAIMessages(window)
	if _, ok := got[0].Content.([]aiPart); ok {
		t.Fatal("oldest chart must NOT resend its bytes")
	}
	if s, _ := got[0].Content.(string); !strings.Contains(s, "[chart image attached earlier]") {
		t.Fatalf("withheld chart needs a marker, got %#v", got[0].Content)
	}
	for _, i := range []int{2, 4} {
		if _, ok := got[i].Content.([]aiPart); !ok {
			t.Fatalf("turn %d is within the last %d image turns and must inline bytes", i, maxImageTurns)
		}
	}
}

func TestAssembleAIMessagesWithholdsBytesWhenNoDataURL(t *testing.T) {
	m := Message{ID: "u1", Role: "user", Content: "chart", Attachments: []Attachment{{MediaType: "image/png"}}}
	if _, ok := assembleAIMessages([]Message{m})[0].Content.([]aiPart); ok {
		t.Fatal("no inline bytes -> no parts")
	}
}

// ── persistence shape + wire contract ──────────────────────────────────────

func TestMessageJSONRoundTripWithAttachment(t *testing.T) {
	raw, err := json.Marshal(chartMsg("u1", "x"))
	if err != nil {
		t.Fatal(err)
	}
	var out Message
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	if out.ID != "u1" || len(out.Attachments) != 1 || out.Attachments[0].DataURL != tinyPNG {
		t.Fatalf("round trip lost data: %+v", out)
	}
}

func TestApplyWindowCountsImageTokens(t *testing.T) {
	// Identical text histories; the charted one must keep fewer turns because
	// every attachment costs imageTokens of prompt budget.
	text := strings.Repeat("x", 2000) // ~500 tokens
	var plain, charted []Message
	for i := 0; i < 40; i++ {
		plain = append(plain, msg("user", text))
		m := msg("user", text)
		m.Attachments = []Attachment{{MediaType: "image/png", DataURL: tinyPNG}}
		charted = append(charted, m)
	}
	if len(ApplyWindow(charted, "")) >= len(ApplyWindow(plain, "")) {
		t.Fatalf("attachments must consume the window budget: %d !< %d",
			len(ApplyWindow(charted, "")), len(ApplyWindow(plain, "")))
	}
}

func TestAIRequestCarriesSessionIDAndImageParts(t *testing.T) {
	body, err := json.Marshal(aiRequest{SessionID: "chat_1_x", Messages: assembleAIMessages([]Message{chartMsg("u1", "read")})})
	if err != nil {
		t.Fatal(err)
	}
	s := string(body)
	for _, want := range []string{`"session_id":"chat_1_x"`, `"type":"image_url"`, `"id":"u1"`, `"detail":"low"`} {
		if !strings.Contains(s, want) {
			t.Fatalf("aiRequest missing %s: %s", want, s)
		}
	}
}

func TestChatEventCarriesMessageIDOnlyWhenSet(t *testing.T) {
	raw, _ := json.Marshal(ChatEvent{Type: "done", MessageID: "u1", Text: "ok"})
	if !strings.Contains(string(raw), `"messageId":"u1"`) {
		t.Fatalf("done event must echo the turn id: %s", raw)
	}
	raw, _ = json.Marshal(ChatEvent{Type: "chunk", Text: "x"})
	if strings.Contains(string(raw), "messageId") {
		t.Fatalf("chunk frames should not carry messageId: %s", raw)
	}
}
