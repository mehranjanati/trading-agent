package tickfeed

import (
	"context"
	"fmt"
	"time"

	"github.com/coder/websocket"

	"trading-agent/go-watcher/conn"
	"trading-agent/go-watcher/normalize"
)

// WS is the production feed: dial → subscribe → normalize → emit (+ Redis
// last-tick publish). It reconnects with conn.Backoff forever; a session that
// delivered ticks resets the backoff, so a flapping venue recovers quickly.
type WS struct {
	// URL is the venue WS endpoint; conn.DefaultWSURL when empty.
	URL string
	// Topic is the subscribed topic ("trade" when empty; markPrice works too).
	Topic string
	// PingEvery keeps the socket inside the venue's 5-minute idle disconnect;
	// conn.PingInterval when zero.
	PingEvery time.Duration
	// DialTimeout bounds one dial; 10s when zero.
	DialTimeout time.Duration
	// Backoff returns the wait before attempt n (1-based); conn.Backoff when nil.
	Backoff func(attempt int) time.Duration
	// Publish is called for every WS tick before emit; nil disables it
	// (main wires tickfeed.PublishRedis when Redis is configured).
	Publish func(normalize.Tick) error
	// Now is injectable for tests; time.Now when nil.
	Now func() time.Time
}

// Name implements Source.
func (WS) Name() string { return "ws" }

// Run keeps one session alive until ctx is cancelled.
func (w WS) Run(ctx context.Context, symbols []string, emit func(normalize.Tick)) error {
	if len(symbols) == 0 {
		return fmt.Errorf("tickfeed: ws source needs at least one symbol")
	}
	attempt := 0
	for {
		n, err := w.session(ctx, symbols, emit)
		if ctx.Err() != nil {
			return nil
		}
		if n > 0 {
			attempt = 0 // the session was productive: start the backoff over
		}
		attempt++
		wait := conn.Backoff(attempt)
		if w.Backoff != nil {
			wait = w.Backoff(attempt)
		}
		_ = err // the reconnect itself is the report; counters live in metrics
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(wait):
		}
	}
}

// session dials, subscribes and reads until the socket fails. It returns how
// many ticks it delivered so Run can decide whether the backoff should reset.
func (w WS) session(ctx context.Context, symbols []string, emit func(normalize.Tick)) (int, error) {
	url := w.URL
	if url == "" {
		url = conn.DefaultWSURL
	}
	topic := w.Topic
	if topic == "" {
		topic = "trade"
	}
	timeout := w.DialTimeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	now := w.Now
	if now == nil {
		now = time.Now
	}

	dctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	c, _, err := websocket.Dial(dctx, url, nil)
	if err != nil {
		return 0, fmt.Errorf("tickfeed: ws dial: %w", err)
	}
	defer c.Close(websocket.StatusNormalClosure, "session end")

	wsSyms := make([]string, 0, len(symbols))
	for _, s := range symbols {
		wsSyms = append(wsSyms, wsSymbol(s))
	}
	sub, err := conn.Subscribe(wsSyms, topic)
	if err != nil {
		return 0, err
	}
	if err := c.Write(ctx, websocket.MessageText, sub); err != nil {
		return 0, fmt.Errorf("tickfeed: ws subscribe: %w", err)
	}

	pingEvery := w.PingEvery
	if pingEvery <= 0 {
		pingEvery = conn.PingInterval
	}
	pctx, stop := context.WithCancel(ctx)
	defer stop()
	go w.pingLoop(pctx, c, pingEvery, now)

	count := 0
	for {
		_, raw, err := c.Read(ctx)
		if err != nil {
			return count, err
		}
		ticks, _ := normalize.ParseTrade(raw, now().UnixMilli())
		for _, t := range ticks {
			if w.Publish != nil {
				_ = w.Publish(t)
			}
			emit(t)
			count++
		}
	}
}

// pingLoop keeps the venue from dropping an idle socket ({"ping": ms}).
func (w WS) pingLoop(ctx context.Context, c *websocket.Conn, every time.Duration, now func() time.Time) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			msg, err := conn.Ping(now())
			if err != nil {
				return
			}
			pctx, cancel := context.WithTimeout(ctx, 5*time.Second)
			err = c.Write(pctx, websocket.MessageText, msg)
			cancel()
			if err != nil {
				return
			}
		}
	}
}
