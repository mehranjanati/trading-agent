// Command flap — E02-T02-S3: reconnect-policy drill without network.
// Simulates 10 forced drops against conn.Backoff and asserts 10 clean resubscribes.
// Run: go run ./cmd/flap
package main

import (
	"fmt"
	"os"
	"time"

	"trading-agent/go-watcher/conn"
	"trading-agent/go-watcher/metrics"
)

func main() {
	c := &metrics.Counters{}
	const drops = 10
	for i := 0; i < drops; i++ {
		c.Disconnects.Add(1)
		d := conn.Backoff(i)
		if d < time.Second || d > 61*time.Second {
			fmt.Println("FAIL: backoff out of bounds")
			os.Exit(1)
		}
		c.BackoffsMs.Add(d.Milliseconds())
		// resubscribe shape check (no network): rebuild messages for 3 symbols × 2 topics
		for _, topic := range []string{"trade", "markPrice"} {
			if _, err := conn.Subscribe([]string{"BTC-SWAP-USDT", "ETH-SWAP-USDT", "SOL-SWAP-USDT"}, topic); err != nil {
				fmt.Println("FAIL: resubscribe build:", err)
				os.Exit(1)
			}
			c.Resubscribes.Add(1)
		}
		c.Connects.Add(1)
		if _, err := conn.Ping(time.Now()); err != nil {
			fmt.Println("FAIL: ping build:", err)
			os.Exit(1)
		}
		c.Pings.Add(1)
	}
	fmt.Printf("flap-drill: %d drops → %d clean resubscribes\n%s", drops, c.Resubscribes.Load(), c.Render())
	if c.Resubscribes.Load() != drops*2 {
		fmt.Println("FAIL: resubscribe count mismatch")
		os.Exit(1)
	}
	fmt.Println("flap-drill: PASS")
}
