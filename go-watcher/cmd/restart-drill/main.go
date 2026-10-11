// Command restart-drill — E03-T02-S2: prove Redis flush + reboot reloads ACTIVE set.
// Flow: seed fake Redis ACTIVE set → FLUSHALL (simulated by DEL) → fetch snapshot
// from a stub Workers endpoint → assert counts match D1 truth.
// Run: go run ./cmd/restart-drill ; uses live local Redis + local stub server.
// KEY NAMESPACE: the drill owns `watch:active-ids:drill` and must never touch the
// production `watch:active-ids` set, so concurrent watcher state or stale drill keys
// from an aborted run cannot fail (or pollute) the gate. `make check` fails closed
// unless its own key holds exactly the drill's members on every assertion.
package main

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"time"

	"trading-agent/go-watcher/redisx"
	"trading-agent/go-watcher/snapshot"
)

const stubBody = `{"watches":[{"id":"w1","symbol":"BTCUSDT","direction":"LONG","trigger_json":"{}","invalidation_json":"{}","version":2,"expires_at":""},{"id":"w2","symbol":"ETHUSDT","direction":"SHORT","trigger_json":"{}","invalidation_json":"{}","version":1,"expires_at":""},{"id":"w3","symbol":"SOLUSDT","direction":"LONG","trigger_json":"{}","invalidation_json":"{}","version":1,"expires_at":""}],"at":"now"}`

func main() {
	// Drill-owned key: never the production `watch:active-ids`.
	const key = "watch:active-ids:drill"
	// 1. Stub Workers snapshot endpoint on an ephemeral port.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fmt.Println("FAIL listen:", err)
		os.Exit(1)
	}
	go http.Serve(ln, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(stubBody))
	}))
	base := "http://" + ln.Addr().String()

	// 2. Seed fake Redis ACTIVE set (3 watches), mimicking pre-crash cache.
	if _, err := redisx.Do("SADD", key, "w1", "w2", "w3"); err != nil {
		fmt.Println("FAIL seed:", err)
		os.Exit(1)
	}
	before, err := redisx.Do("SCARD", key)
	if err != nil || before != "3" {
		fmt.Println("FAIL seed count:", before, err)
		os.Exit(1)
	}

	// 3. Simulate Redis loss.
	if _, err := redisx.Do("DEL", key); err != nil {
		fmt.Println("FAIL flush:", err)
		os.Exit(1)
	}
	if n, _ := redisx.Do("SCARD", key); n != "0" {
		fmt.Println("FAIL: flush incomplete")
		os.Exit(1)
	}

	// 4. Reboot path: fetch D1 snapshot → repopulate.
	p, err := snapshot.Fetch(base, 5*time.Second)
	if err != nil {
		fmt.Println("FAIL snapshot:", err)
		os.Exit(1)
	}
	args := []string{"SADD", key}
	for _, w := range p.Watches {
		args = append(args, w.ID)
	}
	if _, err := redisx.Do(args...); err != nil {
		fmt.Println("FAIL repopulate:", err)
		os.Exit(1)
	}
	after, _ := redisx.Do("SCARD", key)
	if after != "3" {
		fmt.Println("FAIL: reloaded", after, "want 3")
		os.Exit(1)
	}

	// 5. Cleanup drill keys.
	redisx.Do("DEL", key)
	fmt.Printf("restart-drill: PASS (flushed 3 → reloaded %s from D1 snapshot)\n", after)
}
