package conn_test

import (
	"encoding/json"
	"testing"
	"time"

	"trading-agent/go-watcher/conn"
)

func TestSubscribeShape(t *testing.T) {
	// S1 acceptance: exact verified subscribe shape.
	b, err := conn.Subscribe([]string{"BTC-SWAP-USDT", "ETH-SWAP-USDT"}, "trade")
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	if m["symbol"] != "BTC-SWAP-USDT,ETH-SWAP-USDT" || m["topic"] != "trade" || m["event"] != "sub" {
		t.Fatalf("bad subscribe shape: %s", b)
	}
	if _, err := conn.Subscribe(nil, "trade"); err == nil {
		t.Fatal("expected error on empty symbols")
	}
}

func TestPingShape(t *testing.T) {
	b, err := conn.Ping(time.UnixMilli(1535975085052))
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	if m["ping"] != float64(1535975085052) {
		t.Fatalf("bad ping: %s", b)
	}
}

func TestBackoffBounds(t *testing.T) {
	// S3: 1s floor-ish → 60s+1s cap.
	for i := 0; i < 10; i++ {
		d := conn.Backoff(i)
		if d < 1*time.Second || d > 61*time.Second {
			t.Fatalf("attempt %d backoff out of bounds: %v", i, d)
		}
	}
	if conn.DefaultWSURL != "wss://stream.toobit.com/quote/ws/v1" {
		t.Fatal("WS URL drift from verified fact")
	}
}
