// Package metrics — E02-T02-S3: soak/flap counters (stdlib-only, no Prometheus dep).
// Exported as plain text on /metrics-style handler in main.go (E03 wires Redis).
package metrics

import (
	"fmt"
	"sync/atomic"
)

// Counters holds lifetime connector stats for soak-log review.
type Counters struct {
	Connects     atomic.Int64
	Disconnects  atomic.Int64
	Resubscribes atomic.Int64
	Ticks        atomic.Int64
	Dropped      atomic.Int64
	Pings        atomic.Int64
	Pongs        atomic.Int64
	BackoffsMs   atomic.Int64 // cumulative reconnect sleep, for soak analysis
}

// Render returns a human + scrape-friendly summary.
func (c *Counters) Render() string {
	return fmt.Sprintf(
		"connects=%d disconnects=%d resubscribes=%d ticks=%d dropped=%d pings=%d pongs=%d backoff_ms=%d\n",
		c.Connects.Load(), c.Disconnects.Load(), c.Resubscribes.Load(),
		c.Ticks.Load(), c.Dropped.Load(), c.Pings.Load(), c.Pongs.Load(), c.BackoffsMs.Load(),
	)
}
