package tgsignals

import (
	"strings"
	"testing"
	"time"
)

const falconSample = `SPX-SWAP-USDT
Exchange: ToobitFutures
Category: Crypto
Timeframe: FiveMinutes
Position type : Toobit Tiger
Pivot type : SuperMinor
View Chart
Money Management
Close candle Time: 10/18/2026 12:15:00 AM
Channel : @atlas_mining

پینوشت1: پیشنهاد خرید و فروش نیست و تنها یک موقعیت است که توسط t.me/AtlasFalconBot پیدا شده، مسئولیت معاملات شما در نتیجه سود و ضررهایتان تنها متوجه خود شما است، لذا هیچگونه مسئولیتی از طرف ما پذیرفته نیست.`

func TestParseFalcon(t *testing.T) {
	s, err := Parse(BotUsername, falconSample, 123, 1760741700, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if s.Symbol != "SPX-SWAP-USDT" {
		t.Fatalf("symbol=%q", s.Symbol)
	}
	if s.Canonical != "SPXUSDT" {
		t.Fatalf("canonical=%q", s.Canonical)
	}
	if s.Exchange != "ToobitFutures" || s.Timeframe != "FiveMinutes" {
		t.Fatalf("exchange=%q timeframe=%q", s.Exchange, s.Timeframe)
	}
	if s.Position != "Toobit Tiger" || s.Pivot != "SuperMinor" {
		t.Fatalf("position=%q pivot=%q", s.Position, s.Pivot)
	}
	if s.Channel != "@atlas_mining" {
		t.Fatalf("channel=%q", s.Channel)
	}
	if s.CloseUnix <= 0 {
		t.Fatalf("close_unix=%d", s.CloseUnix)
	}
}

func TestParseRejectsNonSetup(t *testing.T) {
	for _, txt := range []string{"", "سلام چطوری", "View Chart\nMoney Management"} {
		if _, err := Parse(BotUsername, txt, 1, 0, time.Now()); err == nil {
			t.Fatalf("expected error for %q", txt)
		}
	}
}

func TestSinkDedupeAndSkip(t *testing.T) {
	oldDo, oldArr := RedisDo, RedisDoArray
	RedisDo = func(args ...string) (string, error) { return "ok", nil }
	RedisDoArray = func(args ...string) ([]string, error) { return nil, nil }
	defer func() { RedisDo, RedisDoArray = oldDo, oldArr }()

	s := NewSink()
	got, err := s.Ingest(BotUsername, falconSample, 7, 0)
	if err != nil || got == nil {
		t.Fatalf("ingest=%v err=%v", got, err)
	}
	// Same bot+msgID again → dupe, no error, no second accept.
	got, err = s.Ingest(BotUsername, falconSample, 7, 0)
	if err != nil || got != nil {
		t.Fatalf("dupe should skip: %v %v", got, err)
	}
	if s.Accept != 1 || s.Dupes != 1 {
		t.Fatalf("accept=%d dupes=%d", s.Accept, s.Dupes)
	}
	// Non-setup text → skip.
	got, err = s.Ingest(BotUsername, "hello", 8, 0)
	if err != nil || got != nil {
		t.Fatalf("non-setup should skip: %v %v", got, err)
	}
}

func TestEndpointHistoryLatest(t *testing.T) {
	oldDo, oldArr := RedisDo, RedisDoArray
	RedisDo = func(args ...string) (string, error) {
		if args[0] == "GET" {
			return `{"symbol":"SPX-SWAP-USDT"}`, nil
		}
		return "ok", nil
	}
	RedisDoArray = func(args ...string) ([]string, error) {
		return []string{`{"a":1}`, `{"a":2}`}, nil
	}
	defer func() { RedisDo, RedisDoArray = oldDo, oldArr }()

	out, err := History(BotUsername, 2)
	if err != nil || !strings.Contains(out, `"a":1`) {
		t.Fatalf("history=%q err=%v", out, err)
	}
	lat, err := Latest(BotUsername)
	if err != nil || !strings.Contains(lat, "SPX") {
		t.Fatalf("latest=%q err=%v", lat, err)
	}
}
