// Package stream — E03-T01-S2: Redis Streams event envelope (RESP builders).
// Emits XADD events:watch with stable evt IDs; consumer group cg-workers.
// Uses raw RESP over net.Conn — no client dependency (stdlib-only, like conn).
package stream

import (
	"crypto/rand"
	"encoding/binary"
	"fmt"
	"strings"
	"time"
)

const (
	// StreamWatch is the trigger-event stream; StreamMarket carries raw ticks.
	StreamWatch  = "events:watch"
	StreamMarket = "events:market"
	// Group is the Workers consumer group (E05 XREADGROUP).
	Group       = "cg-workers"
	MaxLen      = 100000
	evtAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
)

// EventID returns evt_<ulid>: 26-char Crockford base32 + ms timestamp prefix sortable.
func EventID(now time.Time) string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	ms := uint64(now.UnixMilli())
	out := make([]byte, 0, 30)
	out = append(out, "evt_"...)
	// 10-char time part (48 bits big-endian → base32)
	t := ms
	for i := 0; i < 10; i++ {
		out = append(out, evtAlphabet[(t>>(45-5*i))&31])
	}
	_ = binary.LittleEndian
	for i := 0; i < 16; i++ {
		out = append(out, evtAlphabet[b[i]&31])
	}
	return string(out)
}

// TriggerFields builds the XADD field map for watch.triggered_v1.
// dedupe_key = type:watch_id:seq (UNIQUE in D1).
func TriggerFields(evtID, watchID string, seq int, symbol, px string, tsMs int64) map[string]string {
	return map[string]string{
		"id":         evtID,
		"type":       "watch.triggered_v1",
		"v":          "1",
		"entity_id":  watchID,
		"seq":        fmt.Sprintf("%d", seq),
		"dedupe_key": fmt.Sprintf("watch.triggered_v1:%s:%d", watchID, seq),
		"symbol":     symbol,
		"px":         px,
		"ts":         fmt.Sprintf("%d", tsMs),
	}
}

// XAdd builds the raw XADD command: XADD <stream> MAXLEN ~ <n> * f v f v ...
func XAdd(stream string, maxlen int, fields map[string]string) string {
	var sb strings.Builder
	n := 2 + 3 + len(fields)*2 // XADD stream MAXLEN ~ maxlen * + pairs
	fmt.Fprintf(&sb, "*%d\r\n", n)
	writeArg(&sb, "XADD")
	writeArg(&sb, stream)
	writeArg(&sb, "MAXLEN")
	writeArg(&sb, "~")
	writeArg(&sb, fmt.Sprintf("%d", maxlen))
	writeArg(&sb, "*")
	for k, v := range fields {
		writeArg(&sb, k)
		writeArg(&sb, v)
	}
	return sb.String()
}

func writeArg(sb *strings.Builder, s string) {
	fmt.Fprintf(sb, "$%d\r\n%s\r\n", len(s), s)
}

// MkGroup builds MKSTREAM consumer-group creation for the worker group.
func MkGroup(stream, group string) string {
	return fmt.Sprintf("*3\r\n$13\r\nXGROUP\r\n$6\r\nCREATE\r\n$%d\r\n%s\r\n$%d\r\n%s\r\n$1\r\n$\r\n$1\r\n0\r\n", len(stream), stream, len(group), group)
}
