// Package conn — E02-T02-S1: Toobit WS dial/subscribe client (stdlib-only).
// Verified facts (E02-T01, docs/ops/TOOBIT-API-FACTS.md):
//
//	base wss://stream.toobit.com + /quote/ws/v1, topics trade/markPrice/bookTicker,
//	ping {"ping":ms} → {"pong":ms} or disconnect ≤5min, WS symbol form BTC-SWAP-USDT.
package conn

import (
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"time"
)

const (
	// DefaultWSURL is the verified Toobit market-stream host + path.
	DefaultWSURL = "wss://stream.toobit.com/quote/ws/v1"
	// PingInterval keeps us far inside the 5-minute server disconnect budget.
	PingInterval = 60 * time.Second
	// Backoff bounds for reconnect (S3): 1s → 60s with jitter.
	BackoffMin = 1 * time.Second
	BackoffMax = 60 * time.Second
)

// SubMessage is the exact verified subscribe shape: symbol(s), topic, event, params.
type SubMessage struct {
	Symbol string         `json:"symbol"`
	Topic  string         `json:"topic"`
	Event  string         `json:"event"`
	Params map[string]any `json:"params"`
}

// Subscribe builds {"symbol": "BTC-SWAP-USDT,...", "topic": t, "event": "sub", ...}.
func Subscribe(symbols []string, topic string) ([]byte, error) {
	if len(symbols) == 0 {
		return nil, fmt.Errorf("conn: no symbols")
	}
	joined := ""
	for i, s := range symbols {
		if i > 0 {
			joined += ","
		}
		joined += s
	}
	return json.Marshal(SubMessage{Symbol: joined, Topic: topic, Event: "sub", Params: map[string]any{"binary": false}})
}

// Cancel builds the matching unsubscribe message.
func Cancel(symbols []string, topic string) ([]byte, error) {
	b, err := Subscribe(symbols, topic)
	if err != nil {
		return nil, err
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, err
	}
	m["event"] = "cancel"
	return json.Marshal(m)
}

// Ping builds {"ping": <unix-ms>}.
func Ping(now time.Time) ([]byte, error) {
	return json.Marshal(map[string]any{"ping": now.UnixMilli()})
}

// Backoff returns 1s→60s exponential with crypto jitter (S3 reconnect policy).
func Backoff(attempt int) time.Duration {
	d := BackoffMin << attempt
	if d > BackoffMax || d <= 0 {
		d = BackoffMax
	}
	var b [8]byte
	_, _ = rand.Read(b[:])
	jitter := time.Duration(binary.LittleEndian.Uint64(b[:]) % uint64(time.Second))
	return d + jitter
}
