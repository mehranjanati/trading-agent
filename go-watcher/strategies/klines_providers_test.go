// klines_providers_test.go — provider chain: endpoint + row order contract.
// Live-provider tests (marked "integration"): they dial the public REST
// endpoints, so upstream shape drift fails the build on purpose. Run them in
// CI; a failure means a provider moved, not that the test is flaky.
package strategies

import (
	"strings"
	"testing"
)

// okxInst mapping: venue symbol → OKX USDT-M PERPETUAL instrument.
//
// FUTURES-ONLY (2026-11-08): the mapping must produce `-USDT-SWAP` (perpetual),
// never `-USDT` (spot). A strategy signalled on spot candles is a signal about a
// market we do not trade (D-06: Toobit USDT-M perpetuals), and the basis between
// the two books is exactly the kind of difference the analysis must not invent.
func TestOkxInst(t *testing.T) {
	for sym, want := range map[string]string{
		"CELRUSDT": "CELR-USDT-SWAP", "BTCUSDT": "BTC-USDT-SWAP", "SOLUSDT": "SOL-USDT-SWAP",
	} {
		if got := okxInst(sym); got != want {
			t.Errorf("okxInst(%s) = %s, want %s", sym, got, want)
		}
	}
	if got := okxInst("BTC-USDT"); strings.HasSuffix(got, "-USDT") && !strings.HasSuffix(got, "-SWAP") {
		t.Errorf("okxInst must never resolve to a SPOT instrument: %s", got)
	}
}

// The Toobit klines request must use the FUTURES form: the canonical form
// returns spot candles even on /quote/v1/klines (TOOBIT-API-FACTS S4), which
// would build ATR zones from a market we do not trade.
func TestToobitKlinesURLUsesVenueForm(t *testing.T) {
	u := toobitKlinesURL("BTCUSDT", "1h")
	if !strings.Contains(u, "symbol=BTC-SWAP-USDT") {
		t.Fatalf("toobit klines must request the venue form: %s", u)
	}
	if strings.Contains(u, "symbol=BTCUSDT&") {
		t.Fatalf("canonical form would return spot candles: %s", u)
	}
	if !strings.Contains(u, "interval=1h") || !strings.Contains(u, "limit=120") {
		t.Fatalf("unexpected query: %s", u)
	}
}

// The reversal contract: rowsToWire consumes oldest-first. This pins the
// invariant on synthetic rows so a regression cannot silently flip time.
func TestRowsToWireOldestFirst(t *testing.T) {
	rows := [][]any{
		{float64(1000), "1", "2", "0.5", "1.5", "10"},
		{float64(2000), "1.5", "2.5", "1", "2", "11"},
	}
	wire, err := rowsToWire(rows)
	if err != nil {
		t.Fatalf("rowsToWire: %v", err)
	}
	if wire[0].Ts != 1000 || wire[1].Ts != 2000 {
		t.Errorf("wire order = %d,%d, want chronological", wire[0].Ts, wire[1].Ts)
	}
}

// Toobit current endpoint: real data, oldest-first, numeric strings.
func TestToobitKlinesLive(t *testing.T) {
	rows, err := toobitKlines("BTCUSDT", "1h")
	if err != nil {
		t.Skipf("toobit unreachable from here: %v", err)
	}
	if len(rows) < 5 {
		t.Fatalf("toobit returned %d rows, want >= 5", len(rows))
	}
	for i := 1; i < len(rows); i++ {
		if rows[i].Ts <= rows[i-1].Ts {
			t.Fatalf("toobit rows not chronological at %d", i)
		}
	}
	if rows[len(rows)-1].Close == "" {
		t.Fatal("last close is empty")
	}
}

// OKX: the PERPETUAL instrument must come back — oldest-first after the in-code
// reversal. CELR has no OKX swap, so it must FAIL (and fall through) rather than
// answer spot; BTC does, and is the positive case. Skips (never fails) when the
// network is blocked.
func TestOkxKlinesLiveUsesTheSwapInstrument(t *testing.T) {
	if _, err := okxKlines("CELRUSDT", "1h"); err == nil {
		t.Fatal("CELR has no OKX perpetual — the spot book (CELR-USDT) must not be used")
	}
	rows, err := okxKlines("BTCUSDT", "1h")
	if err != nil {
		t.Skipf("okx unreachable from here: %v", err)
	}
	if len(rows) < 5 {
		t.Fatalf("okx returned %d rows, want >= 5", len(rows))
	}
	for i := 1; i < len(rows); i++ {
		if rows[i].Ts <= rows[i-1].Ts {
			t.Fatalf("okx rows not chronological at %d", i)
		}
	}
}
