package prices

import (
	"context"
	"strings"
	"testing"
	"time"
)

// ── ExtractSymbols ───────────────────────────────────────────────────────────

func TestExtractSymbolsDefaultsAlwaysPresent(t *testing.T) {
	got := ExtractSymbols("hello")
	set := map[string]bool{}
	for _, s := range got {
		set[s] = true
	}
	for _, want := range []string{"BTCUSDT", "ETHUSDT", "SOLUSDT"} {
		if !set[want] {
			t.Fatalf("defaults must always be snapshotted, got %v", got)
		}
	}
}

func TestExtractSymbolsFromTurnText(t *testing.T) {
	got := strings.Join(ExtractSymbols("تحلیل doge و AVAXUSDT لطفا"), " ")
	for _, want := range []string{"DOGEUSDT", "AVAXUSDT"} {
		if !strings.Contains(got, want) {
			t.Fatalf("%s must be extracted from the turn, got %v", want, got)
		}
	}
}

func TestExtractSymbolsCaseInsensitive(t *testing.T) {
	got := strings.Join(ExtractSymbols("btc و ethusdt چطوره؟"), " ")
	for _, want := range []string{"BTCUSDT", "ETHUSDT"} {
		if !strings.Contains(got, want) {
			t.Fatalf("%s must be canonicalized, got %v", want, got)
		}
	}
}

func TestExtractSymbolsDedupesAndCaps(t *testing.T) {
	// 10 usdt tokens + 3 defaults must still fit the snapshot budget.
	got := ExtractSymbols("aaausdt bbbusdt ccusdt dddusdt eeeusdt fffusdt gggusdt hhhusdt iiiusdt jjjusdt")
	if len(got) > maxSymbols {
		t.Fatalf("universe must cap at %d symbols, got %d", maxSymbols, len(got))
	}
	seen := map[string]bool{}
	for _, s := range got {
		if seen[s] {
			t.Fatalf("duplicate symbol %s in %v", s, got)
		}
		seen[s] = true
	}
}

// ── SystemMessage ────────────────────────────────────────────────────────────

func TestSystemMessageRendersPriceWithProvenance(t *testing.T) {
	snap := Snapshot{At: 1700000000000, Prices: []Price{{
		Symbol: "BTCUSDT", Px: "115400.5", Ts: 1699999999000,
		Src: "redis-ws", AgeMs: 1000,
	}}}
	got := SystemMessage(snap)
	for _, want := range []string{"BTCUSDT", "115400.5", "src=redis-ws", "age=1000ms", "LIVE"} {
		if !strings.Contains(got, want) {
			t.Fatalf("rendered context must contain %q, got:\n%s", want, got)
		}
	}
}

func TestSystemMessageLabelsStale(t *testing.T) {
	snap := Snapshot{At: 1, Prices: []Price{{
		Symbol: "ETHUSDT", Px: "3200", Ts: 1, Src: "redis-ws", AgeMs: 20000, Stale: true,
	}}}
	if got := SystemMessage(snap); !strings.Contains(got, "STALE") {
		t.Fatalf("stale tick must be labelled, got:\n%s", got)
	}
}

func TestSystemMessageMissingSymbolForbidsGuessing(t *testing.T) {
	snap := Snapshot{At: 1, Missing: []string{"SOLUSDT"}}
	got := SystemMessage(snap)
	if !strings.Contains(got, "SOLUSDT: UNAVAILABLE") {
		t.Fatalf("missing symbols must be listed, got:\n%s", got)
	}
	if !strings.Contains(got, "do NOT guess") {
		t.Fatalf("model must be told not to guess, got:\n%s", got)
	}
}

func TestSystemMessageEmptySnapshotWarnsExplicitly(t *testing.T) {
	// Total outage: the turn still proceeds, with a truthful line — never a
	// silent empty context the model would fill from memory.
	got := SystemMessage(Snapshot{At: 1})
	if !strings.Contains(got, "No symbol could be fetched") {
		t.Fatalf("empty snapshot must warn explicitly, got:\n%s", got)
	}
	if !strings.Contains(got, "market data is unavailable") {
		t.Fatalf("empty snapshot must instruct the model, got:\n%s", got)
	}
}

// ── decimal validation ───────────────────────────────────────────────────────

func TestDecimalStringValidation(t *testing.T) {
	if v, ok := decimalString("115400.50"); !ok || v != "115400.5" {
		t.Fatalf("valid decimal must canonicalize, got %q %v", v, ok)
	}
	for _, bad := range []string{"", "  ", "abc", "-5", "0", "NaN", "+Inf", "1e999"} {
		if v, ok := decimalString(bad); ok {
			t.Fatalf("%q must be rejected, got %q", bad, v)
		}
	}
}

func TestRawDecimalAcceptsStringAndNumber(t *testing.T) {
	if v, ok := rawDecimal([]byte(`"3200.1"`)); !ok || v != "3200.1" {
		t.Fatalf("string price wrong: %q %v", v, ok)
	}
	if v, ok := rawDecimal([]byte(`115400.50`)); !ok || v != "115400.5" {
		t.Fatalf("numeric price wrong: %q %v", v, ok)
	}
	// null must NOT become 0 — a venue that omits the price reports unavailable.
	if v, ok := rawDecimal([]byte(`null`)); ok {
		t.Fatalf("null price must be rejected, got %q", v)
	}
	for _, bad := range []string{``, `{"a":1}`, `true`} {
		if v, ok := rawDecimal([]byte(bad)); ok {
			t.Fatalf("%s must be rejected, got %q", bad, v)
		}
	}
}

// ── Fetch fail-soft ──────────────────────────────────────────────────────────

func TestFetchNeverFailsAndReportsMissing(t *testing.T) {
	// Cancelled context: no source can answer. The contract is an EMPTY
	// snapshot with the symbol listed as Missing — Fetch must not error/panic,
	// because the chat turn has to proceed with a truthful "unavailable" line.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	snap := Fetch(ctx, []string{"ZZZFAKEUSDT"})
	if snap.Has() {
		t.Fatalf("cancelled fetch must yield no prices, got %+v", snap.Prices)
	}
	if len(snap.Missing) != 1 || snap.Missing[0] != "ZZZFAKEUSDT" {
		t.Fatalf("symbol must be reported missing, got %v", snap.Missing)
	}
	if got := SystemMessage(snap); !strings.Contains(got, "No symbol could be fetched") {
		t.Fatalf("empty snapshot must warn, got:\n%s", got)
	}
}

func TestFetchAndRenderExtractsFromTexts(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	got := FetchAndRender(ctx, "تحلیل btc")
	if !strings.Contains(got, "UNAVAILABLE") && !strings.Contains(got, "BTCUSDT") {
		t.Fatalf("rendered context must mention the universe, got:\n%s", got)
	}
}

// ── Snapshot helpers + extract bound ─────────────────────────────────────────

func TestSnapshotGet(t *testing.T) {
	snap := Snapshot{Prices: []Price{{Symbol: "BTCUSDT", Px: "1"}}}
	if p, ok := snap.Get("btcusdt"); !ok || p.Px != "1" {
		t.Fatalf("Get must be case-insensitive, got %+v %v", p, ok)
	}
	if _, ok := snap.Get("ETHUSDT"); ok {
		t.Fatal("absent symbol must miss")
	}
}

func TestFetchRespectsDeadline(t *testing.T) {
	// A deadline already past must return promptly: the ctx gate stops the
	// Redis pass before it dials, so a blackholed Redis can never stall a
	// chat turn past the snapshot bound.
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	start := time.Now()
	snap := Fetch(ctx, DefaultSymbols())
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("Fetch took %s past an expired deadline — ctx gate is not working", elapsed)
	}
	if snap.Has() {
		t.Fatalf("expired deadline must yield no prices, got %+v", snap.Prices)
	}
	if len(snap.Missing) != len(DefaultSymbols()) {
		t.Fatalf("all defaults must be reported missing, got %v", snap.Missing)
	}
}

func TestExtractSymbolsIsPureStringWork(t *testing.T) {
	// Bounded so pathological input can never stall a chat turn.
	done := make(chan struct{})
	go func() {
		ExtractSymbols(strings.Repeat("usdt ", 5000), strings.Repeat("btc ", 5000))
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("ExtractSymbols too slow for a chat turn")
	}
}
