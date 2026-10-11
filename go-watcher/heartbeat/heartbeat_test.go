// heartbeat_test.go — E06-T02-W0.1: payload shape, lag derivation, transport.
package heartbeat

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"sync"
	"testing"
	"time"
)

func TestBuildAndPayloadShape(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	p := Build(now, 1234, true)
	if p.GoHeartbeatMs != now.UnixMilli() || p.StreamLagMs != 1234 || !p.RedisReachable {
		t.Fatalf("unexpected payload %+v", p)
	}
	b, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"go_heartbeat_ms":1700000000000,"stream_lag_ms":1234,"redis_reachable":true}`
	if string(b) != want {
		t.Fatalf("payload shape changed: %s (want %s) — the Workers route parses these keys", b, want)
	}
}

func TestLagMs(t *testing.T) {
	now := time.UnixMilli(1_700_000_030_000)
	cases := []struct {
		id   string
		want int64
	}{
		{"", 0}, // no entries yet → no observable lag
		{"1700000000000-0", 30000},
		{"1700000002000-3", 28000},
		{"garbage", -1}, // malformed → unknown
		{"-1-0", -1},
		{"1800000000000-0", -1}, // future-dated → unknown, never negative
	}
	for _, c := range cases {
		if got := LagMs(now, c.id); got != c.want {
			t.Errorf("LagMs(%q) = %d, want %d", c.id, got, c.want)
		}
	}
}

func TestPostSendsToWorkersRoute(t *testing.T) {
	var mu sync.Mutex
	var gotPath, gotBody string
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		gotPath, gotBody = r.URL.Path, string(b)
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	})}
	go func() { _ = srv.Serve(ln) }()
	defer srv.Close()

	// trailing slash on the base must not double up the path
	if err := Post("http://"+ln.Addr().String()+"/", Build(time.UnixMilli(7), 0, true), time.Second); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if gotPath != Path {
		t.Fatalf("path = %q, want %q", gotPath, Path)
	}
	var p Payload
	if err := json.Unmarshal([]byte(gotBody), &p); err != nil {
		t.Fatalf("body is not a payload (%s): %v", gotBody, err)
	}
	if p.GoHeartbeatMs != 7 || !p.RedisReachable {
		t.Fatalf("payload = %+v", p)
	}
}

func TestPostRejectsNon200(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	})}
	go func() { _ = srv.Serve(ln) }()
	defer srv.Close()

	if err := Post("http://"+ln.Addr().String(), Build(time.UnixMilli(1), 0, true), time.Second); err == nil {
		t.Fatal("expected an error when the Workers route answers 503")
	}
}
