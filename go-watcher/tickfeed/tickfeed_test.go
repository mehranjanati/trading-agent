// tickfeed_test.go — the two live sources: REST rounds and the WS session loop.
//
// What this guards: a feed may only emit ticks it actually received. A dead
// venue/socket produces NO tick (never a synthetic price), and the WS source must
// come back after a drop instead of dying silently — that reconnect is the
// difference between "the watcher is up" and "the watcher is up and watching".
package tickfeed

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"trading-agent/go-watcher/normalize"
	"trading-agent/go-watcher/prices"
)

func TestRESTEmitsProviderPricesAndSkipsEmptyOnes(t *testing.T) {
	var rounds atomic.Int32
	r := REST{
		Interval: time.Millisecond,
		Fetch: func(context.Context, []string) prices.Snapshot {
			rounds.Add(1)
			return prices.Snapshot{
				At: 1_760_000_000_000,
				Prices: []prices.Price{
					{Symbol: "BTCUSDT", Px: "82160.32", Ts: 1_760_000_000_000, Src: "toobit-rest"},
					{Symbol: "CELRUSDT", Px: "", Ts: 1_760_000_000_000, Src: "okx-rest"}, // no price → no tick
				},
			}
		},
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var got []normalize.Tick
	done := make(chan struct{})
	go func() {
		_ = r.Run(ctx, []string{"BTCUSDT", "CELRUSDT"}, func(t normalize.Tick) {
			got = append(got, t)
			if len(got) == 2 {
				cancel()
			}
		})
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("REST.Run did not stop on ctx cancellation")
	}
	if len(got) != 2 || got[0].Symbol != "BTCUSDT" || got[0].Price != "82160.32" || got[0].Src != "toobit-rest" {
		t.Fatalf("expected two BTC ticks (one per round), got %+v", got)
	}
	if rounds.Load() < 2 {
		t.Fatalf("the poll must repeat (interval), rounds=%d", rounds.Load())
	}
}

func TestRESTRefusesAnEmptySymbolSet(t *testing.T) {
	if err := (REST{}).Run(context.Background(), nil, func(normalize.Tick) {}); err == nil {
		t.Fatal("a feed with nothing to watch is a configuration error, not a silent no-op")
	}
}

// wsServer stands up a venue stand-in: it reads the subscribe frame and then
// feeds the trade envelopes the test hands it, closing the socket on demand.
func wsServer(t *testing.T, sessions *atomic.Int32, subs *sync.Map, feed <-chan string, closeAfter int) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		defer c.Close(websocket.StatusNormalClosure, "bye")
		n := sessions.Add(1)
		_, raw, err := c.Read(r.Context())
		if err != nil {
			return
		}
		subs.Store(int(n), string(raw))
		sent := 0
		for msg := range feed {
			if err := c.Write(r.Context(), websocket.MessageText, []byte(msg)); err != nil {
				return
			}
			sent++
			if closeAfter > 0 && sent >= closeAfter {
				return // drop the socket: the client must reconnect
			}
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func tradeMsg(symbol, px string, ts int64) string {
	b, _ := json.Marshal(map[string]any{
		"symbol": symbol, "topic": "trade",
		"data": []map[string]any{{"v": "1", "t": ts, "p": px, "q": "1", "m": false}},
	})
	return string(b)
}

func TestWSNormalizesTicksAndReconnectsAfterADrop(t *testing.T) {
	var sessions atomic.Int32
	var subs sync.Map
	feed := make(chan string, 4)
	srv := wsServer(t, &sessions, &subs, feed, 1) // one tick per session, then drop

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ticks := make(chan normalize.Tick, 8)
	var published atomic.Int32
	w := WS{
		URL:     "ws" + strings.TrimPrefix(srv.URL, "http"),
		Backoff: func(int) time.Duration { return time.Millisecond },
		Publish: func(normalize.Tick) error { published.Add(1); return nil },
	}
	go func() { _ = w.Run(ctx, []string{"BTCUSDT"}, func(t normalize.Tick) { ticks <- t }) }()

	feed <- tradeMsg("BTC-SWAP-USDT", "82160.32", 1_760_000_000_000)
	first := <-ticks
	if first.Symbol != "BTCUSDT" || first.Price != "82160.32" || first.Src != "trade" || first.TxID != "1" {
		t.Fatalf("tick must be canonical and decimal-exact, got %+v", first)
	}
	// The venue dropped the socket after one message: the source must come back
	// (and a second session must have subscribed again).
	feed <- tradeMsg("BTC-SWAP-USDT", "82161.00", 1_760_000_001_000)
	second := <-ticks
	if second.Price != "82161.00" {
		t.Fatalf("second session must deliver its own tick, got %+v", second)
	}
	if sessions.Load() < 2 {
		t.Fatalf("expected a reconnect, sessions=%d", sessions.Load())
	}
	if published.Load() != 2 {
		t.Fatalf("every WS tick is published to the Redis last-tick store, got %d", published.Load())
	}
	// The subscribe frame carries the venue's WS symbol form, not the canonical one.
	v, ok := subs.Load(1)
	if !ok {
		t.Fatal("no subscribe frame recorded")
	}
	if !strings.Contains(v.(string), "BTC-SWAP-USDT") || !strings.Contains(v.(string), "\"topic\":\"trade\"") {
		t.Fatalf("subscribe frame wrong: %s", v)
	}
	cancel()
}

func TestWSRefusesAnEmptySymbolSet(t *testing.T) {
	if err := (WS{}).Run(context.Background(), nil, func(normalize.Tick) {}); err == nil {
		t.Fatal("a feed with nothing to watch is a configuration error")
	}
}

func TestWSSymbolForm(t *testing.T) {
	if got := wsSymbol("BTCUSDT"); got != "BTC-SWAP-USDT" {
		t.Fatalf("canonical → WS form: %s", got)
	}
	if got := normalize.ToCanonical(wsSymbol("CELRUSDT")); got != "CELRUSDT" {
		t.Fatalf("round-trip must be stable: %s", got)
	}
}
