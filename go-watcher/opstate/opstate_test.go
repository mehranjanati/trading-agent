// opstate_test.go — the operator context the chat model is given each turn.
//
// The acceptance frame: the model must see the REAL book (armed watches, latest
// analyses with the engine's bias, approvals with their single-use state, order
// intents, positions, the active strategy config) — and it must see a section as
// UNAVAILABLE when the control plane could not answer, never a guess. This is the
// package that turns "the AI operator has no idea what is going on" into a
// labelled, age-stamped snapshot.
package opstate

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// fakePlane serves the read-only routes Fetch consumes. fail names routes that
// answer 503 (proving a missing section is rendered, not invented).
func fakePlane(t *testing.T, fail map[string]bool) *httptest.Server {
	t.Helper()
	now := time.Now().UTC()
	ago := func(d time.Duration) string { return now.Add(-d).Format(time.RFC3339) }
	ahead := func(d time.Duration) string { return now.Add(d).Format(time.RFC3339) }
	payloads := map[string]any{
		"/api/watches": map[string]any{"watches": []map[string]any{
			{"id": "w1", "symbol": "BTCUSDT", "direction": "LONG", "status": "ACTIVE", "trigger_json": `{"op":">=","price":"100"}`, "invalidation_json": `{"op":"<=","price":"90"}`, "version": 2, "updated_at": ago(30 * time.Second)},
			{"id": "w2", "symbol": "CELRUSDT", "direction": "SHORT", "status": "ANALYZED", "trigger_json": `{"op":"<=","price":"0.002725"}`, "invalidation_json": `{"op":">=","price":"0.0027338"}`, "version": 4, "updated_at": ago(5 * time.Minute)},
		}},
		"/api/analysis": map[string]any{"runs": []map[string]any{
			{"id": "an2", "watch_id": "w1", "model": "wasm-engine", "confidence": 0.62, "at": ago(2 * time.Minute), "output_json": "not-json"},
			{"id": "an1", "watch_id": "w2", "model": "wasm-engine", "confidence": 0.39, "at": ago(4 * time.Minute), "output_json": `{"bias":"SHORT","confidence":0.39}`},
		}},
		"/api/approvals": map[string]any{"approvals": []map[string]any{
			{"id": "ap1", "watch_id": "w2", "decision": "approve", "approver": "trader:mehran", "used_at": "", "expires_at": ahead(10 * time.Minute), "at": ago(3 * time.Minute)},
			{"id": "ap2", "watch_id": "w1", "decision": "approve", "approver": "trader:mehran", "used_at": ago(time.Minute), "expires_at": ahead(time.Minute), "at": ago(9 * time.Minute)},
		}},
		"/api/orders:intents": map[string]any{"intents": []map[string]any{
			{"id": "in1", "watch_id": "w2", "side": "SELL", "qty": "10", "leverage": 3, "status": "FILLED", "at": ago(6 * time.Minute)},
		}},
		"/api/positions": map[string]any{"positions": []map[string]any{
			{"symbol": "CELRUSDT", "size": "10", "entry_px": "0.0027", "leverage": 3, "updated_at": ago(6 * time.Minute)},
		}},
		"/api/strategy": map[string]any{"versions": []map[string]any{
			{"version": "v1-paper", "activated_by": "system-seed", "at": ago(48 * time.Hour)},
		}},
	}
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if fail[r.URL.Path] {
			http.Error(w, "nope", http.StatusServiceUnavailable)
			return
		}
		body, ok := payloads[r.URL.Path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(body)
	}))
}

func TestSystemMessageRendersTheWholeBook(t *testing.T) {
	srv := fakePlane(t, nil)
	defer srv.Close()

	msg := SystemMessage(Fetch(context.Background(), srv.URL, []string{"CELRUSDT"}))

	for _, want := range []string{
		"OPERATOR STATE",
		"strategy config: v1-paper (activated by system-seed",
		"w1 BTCUSDT LONG v2 trigger >= 100 / invalidation <= 90",
		"an1 CELRUSDT watch=w2 bias=SHORT conf=0.39 model=wasm-engine",
		"ap1 CELRUSDT decision=approve open (expires in",
		"ap2 BTCUSDT decision=approve consumed at",
		"in1 CELRUSDT watch=w2 SELL qty=10 lev=3 status=FILLED",
		"CELRUSDT size=10 entry=0.0027 lev=3",
		"age=",
		"cannot submit an order",
	} {
		if !strings.Contains(msg, want) {
			t.Errorf("system message missing %q\n---\n%s", want, msg)
		}
	}
	if strings.Contains(msg, "- w2 CELRUSDT SHORT v4 trigger") {
		t.Errorf("a non-ACTIVE watch was rendered as armed:\n%s", msg)
	}
}

func TestSystemMessageNeverInventsAnUnparsableBias(t *testing.T) {
	srv := fakePlane(t, nil)
	defer srv.Close()
	msg := SystemMessage(Fetch(context.Background(), srv.URL, nil))
	if !strings.Contains(msg, "an2 BTCUSDT watch=w1 bias=unknown") {
		t.Errorf("an unparsable output_json must render bias=unknown, got:\n%s", msg)
	}
}

func TestSystemMessageDeclaresUnavailableSections(t *testing.T) {
	srv := fakePlane(t, map[string]bool{"/api/analysis": true})
	defer srv.Close()
	snap := Fetch(context.Background(), srv.URL, nil)
	if len(snap.Missing) != 1 || snap.Missing[0] != "analysis" {
		t.Fatalf("Missing = %v, want [analysis]", snap.Missing)
	}
	msg := SystemMessage(snap)
	if !strings.Contains(msg, "UNAVAILABLE this turn: analysis") || !strings.Contains(msg, "do NOT invent") {
		t.Errorf("a failed section must be declared as unavailable, got:\n%s", msg)
	}
	if strings.Contains(msg, "latest analyses") {
		t.Errorf("no analyses were read, so none may be rendered:\n%s", msg)
	}
}

func TestFetchWithoutAnOriginSaysSoInsteadOfGuessing(t *testing.T) {
	snap := Fetch(context.Background(), "", nil)
	msg := SystemMessage(snap)
	if len(snap.Missing) != 1 || !strings.Contains(snap.Missing[0], "no control-plane origin") {
		t.Fatalf("Missing = %v", snap.Missing)
	}
	if !strings.Contains(msg, "UNAVAILABLE this turn") || !strings.Contains(msg, "armed watches: none") {
		t.Errorf("an unconfigured seam must render truthfully, got:\n%s", msg)
	}
}

func TestFocusPutsTheTurnsSymbolsFirstAndCaps(t *testing.T) {
	srv := fakePlane(t, nil)
	defer srv.Close()
	snap := Fetch(context.Background(), srv.URL, []string{"CELRUSDT"})
	if len(snap.Analyses) < 2 || snap.Analyses[0].ID != "an1" {
		t.Fatalf("focus symbol must sort first, got %+v", snap.Analyses)
	}
	snap.Watches = make([]Watch, maxWatches+3)
	snap.focus(nil)
	if len(snap.Watches) != maxWatches {
		t.Errorf("watches = %d, want the cap %d", len(snap.Watches), maxWatches)
	}
}

func TestCondText(t *testing.T) {
	if got := condText(`{"op":"<=","price":"0.002725"}`); got != "<= 0.002725" {
		t.Errorf("condText = %q", got)
	}
	if got := condText(""); got != "none" {
		t.Errorf("empty condText = %q, want none", got)
	}
	if got := condText("{bad"); got != "{bad" {
		t.Errorf("malformed condText must pass through, got %q", got)
	}
}

func TestAgeLabel(t *testing.T) {
	now := time.Now()
	iso := func(d time.Duration) string { return now.Add(-d).UTC().Format(time.RFC3339) }
	cases := map[string]string{
		iso(12 * time.Second): "age=12s",
		iso(4 * time.Minute):  "age=4m",
		iso(3 * time.Hour):    "age=3h",
		iso(72 * time.Hour):   "age=3d",
		"":                    "age=?",
	}
	for in, want := range cases {
		if got := ageLabel(in, now.UnixMilli()); got != want {
			t.Errorf("ageLabel(%q) = %q, want %q", in, got, want)
		}
	}
}
