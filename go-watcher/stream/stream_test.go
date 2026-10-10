package stream_test

import (
	"strings"
	"testing"
	"time"

	"trading-agent/go-watcher/stream"
)

func TestEventIDShape(t *testing.T) {
	id := stream.EventID(time.UnixMilli(1728518400000))
	if !strings.HasPrefix(id, "evt_") || len(id) != 30 {
		t.Fatalf("bad evt id: %q len=%d", id, len(id))
	}
	if id == stream.EventID(time.UnixMilli(1728518400000)) {
		t.Fatal("IDs must be unique (random part)")
	}
}

func TestTriggerFieldsDedupe(t *testing.T) {
	f := stream.TriggerFields("evt_X", "w_abc", 3, "BTCUSDT", "67234.5", 1728518400000)
	if f["dedupe_key"] != "watch.triggered_v1:w_abc:3" {
		t.Fatalf("bad dedupe: %s", f["dedupe_key"])
	}
	if f["type"] != "watch.triggered_v1" || f["v"] != "1" {
		t.Fatalf("bad envelope: %+v", f)
	}
}

func TestXAddShape(t *testing.T) {
	f := stream.TriggerFields("evt_X", "w_1", 1, "BTCUSDT", "1", 1)
	cmd := stream.XAdd(stream.StreamWatch, stream.MaxLen, f)
	if !strings.Contains(cmd, "XADD") || !strings.Contains(cmd, "events:watch") || !strings.Contains(cmd, "MAXLEN") {
		t.Fatalf("bad XADD: %q", cmd[:60])
	}
	if stream.Group != "cg-workers" || stream.MaxLen != 100000 {
		t.Fatal("stream constants drift")
	}
}
