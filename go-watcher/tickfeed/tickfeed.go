// Package tickfeed — live tick sources for the trigger loop.
//
// The loop (triggerloop) is pure: it decides, it does not fetch. This package is
// the transport, with two sources behind one interface:
//
//   - WS   — the production feed (conn builders + normalize): dial, subscribe the
//     trade topic for the ACTIVE symbols, normalize every deal, and publish the
//     last tick to Redis (px:{sym}, the contract prices.go documents) so the chat
//     market context serves WS-sourced prices instead of a REST poll.
//   - REST — the ADR-004 path (prices.Fetch: Redis last-tick → Toobit → Binance),
//     one weight-1 request per symbol per round at the 5s cadence. It is the
//     default because it needs no long-lived socket, and it composes with WS:
//     once the WS feed publishes px:{sym}, Fetch's Redis pass answers from it.
//
// Both are bounded by ctx: Run returns only on cancellation or a fatal
// configuration error, so main can restart a feed when the ACTIVE symbol set
// changes. A symbol set with no watches is not an error — it is a feed with
// nothing to watch, and the caller stops it instead.
package tickfeed

import (
	"context"
	"fmt"
	"time"

	"trading-agent/go-watcher/normalize"
	"trading-agent/go-watcher/prices"
	"trading-agent/go-watcher/redisx"
)

// DefaultInterval is the ADR-004 poll cadence for the REST source.
const DefaultInterval = 5 * time.Second

// LastTickTTL matches prices.go: a tick older than this is not a live quote.
const LastTickTTL = 30 * time.Second

// Source feeds ticks until ctx is done. emit is called from Run's goroutine and
// must not block for long (the loop applies ticks synchronously).
type Source interface {
	// Name is the feed identity used in logs/metrics ("ws" | "rest").
	Name() string
	// Run blocks until ctx is cancelled (returns nil) or the source cannot run
	// at all (returns an error, e.g. no symbols).
	Run(ctx context.Context, symbols []string, emit func(normalize.Tick)) error
}

// REST polls prices.Fetch — Redis last-tick first, then Toobit, then Binance.
type REST struct {
	// Interval is the gap between rounds; DefaultInterval when zero.
	Interval time.Duration
	// Fetch is injectable for tests; prices.Fetch when nil.
	Fetch func(context.Context, []string) prices.Snapshot
	// Now is injectable for tests; time.Now when nil.
	Now func() time.Time
}

// Name implements Source.
func (REST) Name() string { return "rest" }

// Run polls until ctx is cancelled. A round that answers for nobody emits
// nothing — an unreachable venue is NO tick, never a synthetic price.
func (r REST) Run(ctx context.Context, symbols []string, emit func(normalize.Tick)) error {
	if len(symbols) == 0 {
		return fmt.Errorf("tickfeed: rest source needs at least one symbol")
	}
	interval := r.Interval
	if interval <= 0 {
		interval = DefaultInterval
	}
	fetch := r.Fetch
	if fetch == nil {
		fetch = prices.Fetch
	}
	now := r.Now
	if now == nil {
		now = time.Now
	}
	for {
		snap := fetch(ctx, symbols)
		recv := now().UnixMilli()
		for _, p := range snap.Prices {
			if p.Px == "" {
				continue
			}
			ts := p.Ts
			if ts <= 0 {
				ts = recv
			}
			emit(normalize.Tick{Symbol: p.Symbol, Price: p.Px, Ts: ts, Src: p.Src, RecvMs: recv})
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(interval):
		}
	}
}

// PublishRedis writes the normalized last tick where the repo says it lives:
// HASH px:{symbol} {px, ts} with a 30s TTL (prices.go fromRedis reads exactly
// these fields). Called for WS ticks only — a REST poll must not overwrite the
// live WS last tick with a slower value.
func PublishRedis(t normalize.Tick) error {
	if t.Symbol == "" || t.Price == "" {
		return fmt.Errorf("tickfeed: publish needs symbol+price")
	}
	if _, err := redisx.Do("HSET", "px:"+t.Symbol, "px", t.Price, "ts", fmt.Sprintf("%d", t.Ts)); err != nil {
		return err
	}
	_, err := redisx.Do("EXPIRE", "px:"+t.Symbol, fmt.Sprintf("%d", int(LastTickTTL.Seconds())))
	return err
}

// wsSymbol maps the canonical form to the venue's WS form (BTCUSDT →
// BTC-SWAP-USDT) — one implementation with the REST call sites, so the socket
// and the fallback poll can never disagree about which market they quote.
func wsSymbol(symbol string) string {
	return normalize.ToVenue(symbol)
}
