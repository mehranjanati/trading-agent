// Package metrics — E02-T02-S3: soak/flap counters (stdlib-only, no Prometheus dep).
// Exported as plain text on /metrics-style handler in main.go (E03 wires Redis).
package metrics

import (
	"fmt"
	"sync/atomic"
)

// Counters holds lifetime connector stats for soak-log review.
type Counters struct {
	Connects      atomic.Int64
	Disconnects   atomic.Int64
	Resubscribes  atomic.Int64
	Ticks         atomic.Int64
	Dropped       atomic.Int64
	Pings         atomic.Int64
	Pongs         atomic.Int64
	BackoffsMs    atomic.Int64 // cumulative reconnect sleep, for soak analysis
	HeldStale     atomic.Int64 // triggers held for staleness (E03-T02-S1)
	HeldUncertain atomic.Int64 // triggers held for uncertain state (failover)
	Reloads       atomic.Int64 // snapshot reloads completed (E03-T02-S2)
	MaxTickLagMs  atomic.Int64 // high-water recv-ts lag, for SLO review
	// E03-T01 wiring (the trigger loop): ticks evaluated, edges decided, and
	// edges the Worker refused (a refusal is the alert — the watch is not in the
	// state the loop believed, or the plane is unreachable).
	Evals      atomic.Int64
	Fires      atomic.Int64
	FireErrors atomic.Int64
}

// Render returns a human + scrape-friendly summary.
func (c *Counters) Render() string {
	return fmt.Sprintf(
		"connects=%d disconnects=%d resubscribes=%d ticks=%d dropped=%d pings=%d pongs=%d backoff_ms=%d held_stale=%d held_uncertain=%d reloads=%d max_lag_ms=%d evals=%d fires=%d fire_errors=%d\n",
		c.Connects.Load(), c.Disconnects.Load(), c.Resubscribes.Load(),
		c.Ticks.Load(), c.Dropped.Load(), c.Pings.Load(), c.Pongs.Load(), c.BackoffsMs.Load(),
		c.HeldStale.Load(), c.HeldUncertain.Load(), c.Reloads.Load(), c.MaxTickLagMs.Load(),
		c.Evals.Load(), c.Fires.Load(), c.FireErrors.Load(),
	)
}

// ObserveLag records recv-ts lag and tracks the high-water mark.
func (c *Counters) ObserveLag(lagMs int64) {
	for {
		cur := c.MaxTickLagMs.Load()
		if lagMs <= cur || c.MaxTickLagMs.CompareAndSwap(cur, lagMs) {
			return
		}
	}
}
