// strategies engine wiring for main: the analysis Engine is process-scoped
// (shared wazero Runtime) and serves POST /analyze plus pre-baked sample
// strategy files under STRATEGIES_DIR. /analyze is ADVISORY: it costs no
// approval, writes no order, never touches D1 — it exists so the dashboard
// can run deep analysis against real klines before any human approves.
package main

import (
	"context"
	"fmt"
	"net/http"
	"os"

	"trading-agent/go-watcher/strategies"
)

var strategyEngine *strategies.Engine

func strategiesDir() string {
	if d := os.Getenv("STRATEGIES_DIR"); d != "" {
		return d
	}
	return "strategies/samples"
}

// initStrategies builds the shared Runner + Registry + Engine. A nil base or
// a missing/corrupt registry must NOT kill the watcher: the heartbeat path
// is the safety-critical plane, analysis is advisory. Failures land in
// /readyz-independent logging and /analyze returns 503.
func initStrategies() {
	ctx := context.Background()
	runner, err := strategies.NewRunner(ctx)
	if err != nil {
		fmt.Fprintln(os.Stderr, "strategies: runner:", err)
		return
	}
	reg, err := strategies.Open(strategiesDir())
	if err != nil {
		fmt.Fprintln(os.Stderr, "strategies: registry:", err)
		_ = runner.Close(ctx)
		return
	}
	strategyEngine = strategies.NewEngine(reg, runner, os.Getenv("WORKERS_URL"))
	n := len(reg.List())
	fmt.Fprintf(os.Stderr, "strategies: engine ready (%d pinned)\n", n)
}

func serveAnalyze(w http.ResponseWriter, r *http.Request) {
	if strategyEngine == nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"code":"ENGINE_UNAVAILABLE","message":"strategy engine not initialised"}`))
		return
	}
	strategyEngine.ServeAnalyze(w, r)
}

// serveRegistry exposes the pinned catalog over HTTP (GET /strategies/registry).
// A missing engine is reported in the same envelope as /analyze; the CORS header
// is set here too so a browser can READ the 503 instead of seeing an opaque
// network error.
func serveRegistry(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	if strategyEngine == nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"code":"ENGINE_UNAVAILABLE","message":"strategy engine not initialised"}`))
		return
	}
	strategyEngine.ServeRegistry(w, r)
}
