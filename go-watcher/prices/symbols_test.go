package prices

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

// ── the venue CATALOG (what the Worker's symbol picker reads) ────────────────
//
// Regression this file exists for: Toobit answers HTTP 403 to Cloudflare's
// egress while answering this host, so `GET /api/symbols` collapsed onto the
// Worker's D1 rows — FOUR symbols (the allowlist + whatever watches/positions
// had seen) out of ~773 listed USDT-M markets. The dashboard's picker was
// unusable: "I search and nothing but these few coins comes up" (2026-11-08).
// The fix is a second egress that the venue does answer, and these tests pin
// the two rules that keep it from widening the universe dishonestly:
//   - only `-SWAP-` rows are USDT-M perpetuals (a dash-free row is the SPOT
//     book — TOOBIT-API-FACTS S4);
//   - the answer is canonical, deduped and sorted, so the Worker's SYMBOL_RE
//     and the risk gate's R-SYM see the one identity they already match.

func TestParseVenueSymbolsKeepsOnlyUsdtMPerpetuals(t *testing.T) {
	body := []byte(`[
		{"s":"BTC-SWAP-USDT","p":"67000"},
		{"s":"BTCUSDT","p":"67001"},
		{"s":"eth-swap-usdt","p":"3500"},
		{"s":"DOGE-SWAP-USDC","p":"0.2"},
		{"s":"1INCH-SWAP-USDT","p":"0.4"},
		{"s":"nope","p":"1"},
		{"p":"2"}
	]`)
	got := ParseVenueSymbols(body)
	want := []string{"BTCUSDT", "ETHUSDT"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("catalog = %v, want %v (spot echo, USDC-M and junk must be refused)", got, want)
	}
}

func TestParseVenueSymbolsToleratesTheDataEnvelope(t *testing.T) {
	// The venue has answered both shapes; neither may crash the catalog.
	got := ParseVenueSymbols([]byte(`{"data":[{"s":"SOL-SWAP-USDT","p":"170"}]}`))
	if !reflect.DeepEqual(got, []string{"SOLUSDT"}) {
		t.Fatalf("envelope form = %v, want [SOLUSDT]", got)
	}
	if got := ParseVenueSymbols([]byte(`{"oops":true}`)); got != nil {
		t.Fatalf("unknown shape must be empty, got %v", got)
	}
	if got := ParseVenueSymbols([]byte(`not json`)); got != nil {
		t.Fatalf("garbage must be empty, got %v", got)
	}
}

func TestParseVenueSymbolsDedupesAndSorts(t *testing.T) {
	body := []byte(`[{"s":"SOL-SWAP-USDT"},{"s":"ETH-SWAP-USDT"},{"s":"SOL-SWAP-USDT"},{"s":"BTC-SWAP-USDT"}]`)
	want := []string{"BTCUSDT", "ETHUSDT", "SOLUSDT"}
	if got := ParseVenueSymbols(body); !reflect.DeepEqual(got, want) {
		t.Fatalf("catalog = %v, want %v", got, want)
	}
}

func TestSymbolsReadsTheVenuePathAndFailsLoud(t *testing.T) {
	var path string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`[{"s":"BTC-SWAP-USDT","p":"82440"}]`))
	}))
	defer srv.Close()
	t.Setenv("TOOBIT_BASE", srv.URL)

	symbols, source, err := Symbols(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if path != symbolsPath {
		t.Fatalf("read %q, want %q", path, symbolsPath)
	}
	if source != "toobit-rest" {
		t.Fatalf("source = %q", source)
	}
	if !reflect.DeepEqual(symbols, []string{"BTCUSDT"}) {
		t.Fatalf("symbols = %v", symbols)
	}
}

func TestSymbolsNeverAnswersAnEmptyCatalog(t *testing.T) {
	// An empty 200 would read as "the venue lists nothing", which the Worker
	// would then prefer over its own D1 fallback — the exact lie this path
	// must not tell.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`[{"s":"BTCUSDT","p":"67000"}]`)) // spot-only answer
	}))
	defer srv.Close()
	t.Setenv("TOOBIT_BASE", srv.URL)
	if _, _, err := Symbols(context.Background()); err == nil {
		t.Fatal("a spot-only answer must be an error, not an empty catalog")
	}
}

func TestValidSymbolMirrorsTheWorkerRegex(t *testing.T) {
	for _, s := range []string{"BTCUSDT", "SOLUSDT", "CELRUSDT"} {
		if !ValidSymbol(s) {
			t.Fatalf("%s must be valid", s)
		}
	}
	for _, s := range []string{"BTC-SWAP-USDT", "BTCUSDC", "btcusdt", "", "1INCHUSDT"} {
		if ValidSymbol(s) {
			t.Fatalf("%s must be refused (workers/src/symbols.mjs SYMBOL_RE)", s)
		}
	}
}

// ── the BATCH ticker read (what /api/market/prices uses) ────────────────────
//
// Regression this file exists for: the venue's per-request TLS handshake
// measured up to 6.8s, so 25 per-symbol reads (the cockpit sidebar) either timed
// out or blew the caller's deadline and the desk showed "price UNAVAILABLE ...
// venue HTTP 403" for symbols the venue was answering. ONE unfiltered read is
// weight 1 instead of 25, one handshake instead of 25, and covers every listed
// market — but it must not let the spot book or a broken price in.
func TestParseVenueTickersKeepsOnlyPerpetualPrices(t *testing.T) {
	rows := []TickerRow{
		{S: "BTC-SWAP-USDT", P: []byte(`"67000.5"`)},
		{S: "ETH-SWAP-USDT", P: []byte(`3500`)},        // numeric scalar
		{S: "BTCUSDT", P: []byte(`"67001"`)},           // spot echo: refused
		{S: "DOGE-SWAP-USDC", P: []byte(`"0.2"`)},      // USDC-margined: refused
		{S: "SOL-SWAP-USDT", P: []byte(`"0"`)},         // zero is missing, not a price
		{S: "XRP-SWAP-USDT", P: []byte(`"not-a-num"`)}, // garbage: refused
		{S: "", P: []byte(`"1"`)},
	}
	got := ParseVenueTickers(rows)
	want := map[string]string{"BTCUSDT": "67000.5", "ETHUSDT": "3500"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("tickers = %v, want %v", got, want)
	}
}

func TestVenueTickersReadsTheUnfilteredPath(t *testing.T) {
	var query string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query = r.URL.RawQuery
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`[{"s":"BTC-SWAP-USDT","si":"BTC-SWAP-USDT","p":"82440"},{"s":"ACN-SWAP-USDT","p":"258.84"}]`))
	}))
	defer srv.Close()
	t.Setenv("TOOBIT_BASE", srv.URL)

	got, err := VenueTickers(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if query != "" {
		t.Fatalf("the batch read must be UNFILTERED (one weight-1 read), got ?%s", query)
	}
	if got["BTCUSDT"] != "82440" || got["ACNUSDT"] != "258.84" {
		t.Fatalf("tickers = %v", got)
	}
}

func TestVenueTickersNeverAnswersAnEmptyMap(t *testing.T) {
	// A spot-only answer must be an ERROR: an empty success would be handed to
	// the Worker as "no price exists for these symbols".
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`[{"s":"BTCUSDT","p":"67000"}]`))
	}))
	defer srv.Close()
	t.Setenv("TOOBIT_BASE", srv.URL)
	if _, err := VenueTickers(context.Background()); err == nil {
		t.Fatal("a spot-only ticker must be an error, not an empty batch")
	}
}

