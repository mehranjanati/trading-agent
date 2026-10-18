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
	"os"
	"strings"
	"testing"
	"time"
)

// TestMain pins the Telegram seam to a deterministic stub: Fetch must never
// reach a real Redis in tests, and the stub proves the section renders.
func TestMain(m *testing.M) {
	SignalHistory = func(int) (string, error) {
		return `[{"bot":"FalconToobitBot","symbol":"CELR-SWAP-USDT","canonical":"CELRUSDT","timeframe":"FiveMinutes","position":"Toobit Tiger","pivot":"SuperMinor","close_time":"10/18/2026 12:15:00 AM","recv_at":"2026-10-18T00:00:00Z"}]`, nil
	}
	os.Exit(m.Run())
}

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
		"/api/orders": map[string]any{"orders": []map[string]any{
			{"client_order_id": "co1", "exchange_order_id": "ex_9", "status": "FILLED", "fills_json": `[{"qty":"10","price":"0.0027"}]`, "last_reconciled_at": ago(time.Minute), "at": ago(6 * time.Minute)},
		}},
		"/api/strategy:drafts": map[string]any{"drafts": []map[string]any{
			{"id": "dr1", "strategy_id": "sma-cross", "version": "0.1.0", "model": "qwen", "status": "generated", "created_by": "trader", "created_at": ago(20 * time.Minute)},
		}},
		"/strategies/registry": map[string]any{"strategies": []map[string]any{
			{"id": "sma-cross", "version": "1.0.0", "name": "SMA Cross", "status": "active"},
		}},
		"/api/positions": map[string]any{"positions": []map[string]any{
			{"symbol": "CELRUSDT", "size": "10", "entry_px": "0.0027", "leverage": 3, "updated_at": ago(6 * time.Minute)},
		}},
		"/api/strategy": map[string]any{"versions": []map[string]any{
			{"version": "v1-paper", "config_json": `{"risk_per_trade":"0.01","max_leverage":3}`, "activated_by": "system-seed", "at": ago(48 * time.Hour)},
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
	oldReg := RegistryURL
	RegistryURL = srv.URL + "/strategies/registry"
	defer func() { RegistryURL = oldReg }()

	msg := SystemMessage(Fetch(context.Background(), srv.URL, []string{"CELRUSDT"}))

	for _, want := range []string{
		"OPERATOR STATE",
		"strategy config: v1-paper (activated by system-seed",
		"strategy versions (1, newest first",
		`v1-paper by=system-seed config={"risk_per_trade":"0.01","max_leverage":3}`,
		"strategy drafts (1, AI-generated, REVIEW-ONLY",
		"dr1 sma-cross@0.1.0 status=generated model=qwen by=trader",
		"pinned strategy registry",
		"sma-cross@1.0.0 status=active (SMA Cross)",
		"w1 BTCUSDT LONG v2 trigger >= 100 / invalidation <= 90",
		"an1 CELRUSDT watch=w2 bias=SHORT conf=0.39 model=wasm-engine",
		"ap1 CELRUSDT decision=approve open (expires in",
		"ap2 BTCUSDT decision=approve consumed at",
		"in1 CELRUSDT watch=w2 SELL qty=10 lev=3 status=FILLED",
		"co1 exchange=ex_9 status=FILLED fills=1 reconciled age=",
		"CELRUSDT size=10 entry=0.0027 lev=3",
		"CELR-SWAP-USDT→CELRUSDT tf=FiveMinutes pos=Toobit Tiger",
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

// A section that failed must never be rendered as "none": an unread watch list
// is unknown, not empty.
func TestMissingWatchesNeverRenderAsNone(t *testing.T) {
	srv := fakePlane(t, map[string]bool{"/api/watches": true})
	defer srv.Close()
	msg := SystemMessage(Fetch(context.Background(), srv.URL, nil))
	if strings.Contains(msg, "armed watches: none") {
		t.Errorf("unread watches rendered as none:\n%s", msg)
	}
	if !strings.Contains(msg, "UNAVAILABLE this turn: watches") {
		t.Errorf("watches must be declared unavailable, got:\n%s", msg)
	}
}

// An empty-but-read section must say "none", never disappear: silence is
// indistinguishable from "the model has no database access", which is exactly
// the failure users report.
func TestSystemMessageRendersEmptySectionsTruthfully(t *testing.T) {
	msg := SystemMessage(Snapshot{At: time.Now().UnixMilli()})
	for _, want := range []string{
		"ANSWER RULE",
		"strategy versions: none (the version table was read this turn)",
		"strategy drafts: none (the drafts table was read this turn)",
		"exchange orders: none (the orders table was read this turn)",
		"telegram signals: none (Redis was read this turn)",
	} {
		if !strings.Contains(msg, want) {
			t.Errorf("system message missing %q\n---\n%s", want, msg)
		}
	}
	if strings.Contains(msg, "pinned strategy registry:") {
		t.Errorf("an unwired registry must not be claimed:\n%s", msg)
	}
}

func TestSystemMessageUsesTheSummaryFillCount(t *testing.T) {
	msg := SystemMessage(Snapshot{At: time.Now().UnixMilli(), Orders: []Order{
		{ClientOrderID: "co1", Status: "FILLED", FillsCount: 3, At: time.Now().UTC().Format(time.RFC3339)},
	}})
	if !strings.Contains(msg, "co1 exchange=? status=FILLED fills=3") {
		t.Errorf("summary fills_count not used:\n%s", msg)
	}
}

func TestFillsCountAndShortJSON(t *testing.T) {
	if got := fillsCount(`[{"qty":"1"},{"qty":"2"}]`); got != 2 {
		t.Errorf("fillsCount = %d, want 2", got)
	}
	if got := fillsCount("not-json"); got != 0 {
		t.Errorf("malformed fillsCount = %d, want 0", got)
	}
	long := strings.Repeat("x", maxConfigChars+10)
	if got := shortJSON(long, maxConfigChars); len(got) > maxConfigChars+4 || !strings.HasSuffix(got, "…") {
		t.Errorf("shortJSON did not abbreviate: %d chars", len(got))
	}
	if got := shortJSON("", maxConfigChars); got != "{}" {
		t.Errorf("empty shortJSON = %q, want {}", got)
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
