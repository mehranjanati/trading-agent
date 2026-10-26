package normalize_test

import (
	"testing"

	"trading-agent/go-watcher/normalize"
)

const tradeMsg = `{"symbol":"BTC-SWAP-USDT","symbolName":"BTC-SWAP-USDTUSDT","topic":"trade","params":{"realtimeInterval":"24h","binary":"false"},"data":[{"v":"1291465821801168896","t":1668690723096,"p":"399","q":"1","m":false},{"v":"1291465842546196481","t":1668690725569,"p":"400.5","q":"2","m":true}],"f":true,"sendTime":1668753154192}`

const markMsg = `{"symbol":"BTC-SWAP-USDT","symbolName":"BTC-SWAP-USDT","topic":"markPrice","params":{"realtimeInterval":"24h"},"data":[{"symbol":"BTC-SWAP-USDT","markPrice":"16792.28","time":1668754084000}],"f":false,"sendTime":1668754084738}`

func TestSymbolMap(t *testing.T) {
	if got := normalize.ToCanonical("BTC-SWAP-USDT"); got != "BTCUSDT" {
		t.Fatalf("map failed: %s", got)
	}
	if got := normalize.ToCanonical("ETH-SWAP-USDT"); got != "ETHUSDT" {
		t.Fatalf("map failed: %s", got)
	}
}

// ToVenue is the inverse used by EVERY Toobit REST call: the canonical form
// resolves to the spot book, so a futures read must send the dash form
// (docs/ops/TOOBIT-API-FACTS.md S4).
func TestToVenue(t *testing.T) {
	for in, want := range map[string]string{
		"BTCUSDT":       "BTC-SWAP-USDT",
		"ETHUSDT":       "ETH-SWAP-USDT",
		"EDUUSDT":       "EDU-SWAP-USDT",
		"btc-usdt":      "BTC-SWAP-USDT",
		"BTC-SWAP-USDT": "BTC-SWAP-USDT",
		// Non-USDT pairs have no USDT-M contract: pass through (asking 400s).
		"ETHBTC": "ETHBTC",
	} {
		if got := normalize.ToVenue(in); got != want {
			t.Errorf("ToVenue(%q) = %q, want %q", in, got, want)
		}
	}
	if got := normalize.ToCanonical(normalize.ToVenue("EDUUSDT")); got != "EDUUSDT" {
		t.Fatalf("round trip failed: %s", got)
	}
}

func TestParseTrade(t *testing.T) {
	// S2 acceptance: verified example message → 2 canonical ticks + tx IDs.
	ticks, dropped := normalize.ParseTrade([]byte(tradeMsg), 1668753155000)
	if dropped != 0 || len(ticks) != 2 {
		t.Fatalf("ticks=%d dropped=%d", len(ticks), dropped)
	}
	if ticks[0].Symbol != "BTCUSDT" || ticks[0].Price != "399" || ticks[0].TxID != "1291465821801168896" {
		t.Fatalf("bad tick0: %+v", ticks[0])
	}
	if ticks[0].Src != "trade" || ticks[0].RecvMs != 1668753155000 {
		t.Fatalf("bad meta: %+v", ticks[0])
	}
}

func TestParseMark(t *testing.T) {
	ticks, dropped := normalize.ParseMark([]byte(markMsg), 1668754085000)
	if dropped != 0 || len(ticks) != 1 || ticks[0].Price != "16792.28" {
		t.Fatalf("ticks=%+v dropped=%d", ticks, dropped)
	}
}

func TestMalformedDropped(t *testing.T) {
	// Malformed JSON + bad deals → dropped, counted, no panic.
	if _, d := normalize.ParseTrade([]byte("{nope"), 0); d != 1 {
		t.Fatal("expected 1 drop on bad JSON")
	}
	bad := `{"symbol":"BTC-SWAP-USDT","topic":"trade","data":[{"v":"1","t":0,"p":"","q":"1","m":false}]}`
	if _, d := normalize.ParseTrade([]byte(bad), 0); d != 1 {
		t.Fatal("expected 1 drop on bad deal")
	}
}

func TestSanityReject(t *testing.T) {
	hold, err := normalize.SanityReject("100", "101")
	if err != nil || hold {
		t.Fatal("1% must pass")
	}
	hold, err = normalize.SanityReject("100", "103")
	if err != nil || !hold {
		t.Fatal(">2% must hold for confirmation")
	}
}
