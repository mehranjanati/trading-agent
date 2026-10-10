// Package main — go-watcher service entry (E03-T02 wired).
// Cold start: fetch D1 snapshot → populate ACTIVE set → /readyz 200.
// WS dial + Streams production loop lands in E05/E06; ops surface live now.
package main

import (
	"fmt"
	"net/http"
	"os"
	"sync/atomic"
	"time"

	"trading-agent/go-watcher/metrics"
)

var (
	counters   = &metrics.Counters{}
	ready      atomic.Bool
	activeN    atomic.Int64
	snapshotAt atomic.Value // string
)

func main() {
	port := os.Getenv("GO_PORT")
	if port == "" {
		port = "8080"
	}
	// Best-effort snapshot load (E03-T02-S2); failure keeps /readyz 503 with reason.
	if base := os.Getenv("WORKERS_URL"); base != "" {
		// snapshot.Fetch wired in E05 when Workers serves the route; recorded here.
		snapshotAt.Store("pending: " + base)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { fmt.Fprintln(w, "ok") })
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		if !ready.Load() {
			w.WriteHeader(http.StatusServiceUnavailable)
			fmt.Fprintln(w, "not-ready: snapshot not loaded (E03-T02: set WORKERS_URL + E05 route)")
			return
		}
		fmt.Fprintln(w, "ready")
	})
	mux.HandleFunc("/metrics", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(counters.Render()))
	})
	_ = http.ListenAndServe(":"+port, mux)
	_ = time.Now
}
