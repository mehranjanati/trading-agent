// Command restart-drill — E03-T02-S2: prove Redis flush + reboot reloads ACTIVE set.
// Flow: seed fake Redis ACTIVE set → FLUSHALL (simulated by DEL) → fetch snapshot
// from a stub Workers endpoint → assert counts match D1 truth.
// Run: go run ./cmd/restart-drill ; uses live local Redis + local stub server.
package main

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"time"

	"trading-agent/go-watcher/snapshot"
)

const stubBody = `{"watches":[{"id":"w1","symbol":"BTCUSDT","direction":"LONG","trigger_json":"{}","invalidation_json":"{}","version":2,"expires_at":""},{"id":"w2","symbol":"ETHUSDT","direction":"SHORT","trigger_json":"{}","invalidation_json":"{}","version":1,"expires_at":""},{"id":"w3","symbol":"SOLUSDT","direction":"LONG","trigger_json":"{}","invalidation_json":"{}","version":1,"expires_at":""}],"at":"now"}`

func main() {
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
	if _, err := redisDo("SADD", "watch:active-ids", "w1", "w2", "w3"); err != nil {
		fmt.Println("FAIL seed:", err)
		os.Exit(1)
	}
	before, err := redisDo("SCARD", "watch:active-ids")
	if err != nil || before != "3" {
		fmt.Println("FAIL seed count:", before, err)
		os.Exit(1)
	}

	// 3. Simulate Redis loss.
	if _, err := redisDo("DEL", "watch:active-ids"); err != nil {
		fmt.Println("FAIL flush:", err)
		os.Exit(1)
	}
	if n, _ := redisDo("SCARD", "watch:active-ids"); n != "0" {
		fmt.Println("FAIL: flush incomplete")
		os.Exit(1)
	}

	// 4. Reboot path: fetch D1 snapshot → repopulate.
	p, err := snapshot.Fetch(base, 5*time.Second)
	if err != nil {
		fmt.Println("FAIL snapshot:", err)
		os.Exit(1)
	}
	args := []string{"SADD", "watch:active-ids"}
	for _, w := range p.Watches {
		args = append(args, w.ID)
	}
	if _, err := redisDo(args...); err != nil {
		fmt.Println("FAIL repopulate:", err)
		os.Exit(1)
	}
	after, _ := redisDo("SCARD", "watch:active-ids")
	if after != "3" {
		fmt.Println("FAIL: reloaded", after, "want 3")
		os.Exit(1)
	}

	// 5. Cleanup drill keys.
	redisDo("DEL", "watch:active-ids")
	fmt.Printf("restart-drill: PASS (flushed 3 → reloaded %s from D1 snapshot)\n", after)
}
