// Package main — go-watcher service entry.
// E03-T02: cold start (D1 snapshot -> ACTIVE set -> /readyz 200).
// E06-T02-W0.1: 5s liveness publisher (/api/health:heartbeat) + ready drop on
// Redis loss. The production WS dial/Streams loop still lands later; the seams
// below are the ones the failover drills drive.
package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"time"

	"trading-agent/go-watcher/chat"
	"trading-agent/go-watcher/heartbeat"
	"trading-agent/go-watcher/metrics"
	"trading-agent/go-watcher/opstate"
	"trading-agent/go-watcher/prices"
	"trading-agent/go-watcher/redisx"
	"trading-agent/go-watcher/skills"
	"trading-agent/go-watcher/snapshot"
	"trading-agent/go-watcher/stream"
)

const snapshotTimeout = 5 * time.Second

var (
	counters   = &metrics.Counters{}
	ready      atomic.Bool
	readyWhy   atomic.Value // string — last /readyz reason
	activeN    atomic.Int64
	snapshotAt atomic.Value // string
)

func main() {
	// PORT is the platform-assigned port (Render/Fly/Heroku set it per deploy)
	// and wins — a platform that routes to its PORT while we listen elsewhere
	// is a dead service. GO_PORT is the repo-local override (docker-compose,
	// dev shells); 8080 the bare-metal default.
	port := os.Getenv("PORT")
	if port == "" {
		port = os.Getenv("GO_PORT")
	}
	if port == "" {
		port = "8080"
	}
	base := os.Getenv("WORKERS_URL")
	readyWhy.Store("not-ready: cold start")

	// Cold start (§6.6 / E03-T02-S2): fetch the D1 snapshot and repopulate the
	// ACTIVE set. A failed repopulate keeps the process not-ready on purpose.
	if base != "" {
		if err := coldStart(base); err != nil {
			snapshotAt.Store("error: " + err.Error())
			readyWhy.Store("not-ready: " + err.Error())
			fmt.Fprintln(os.Stderr, "cold start:", err)
		} else {
			snapshotAt.Store(time.Now().UTC().Format(time.RFC3339))
			ready.Store(true)
			readyWhy.Store("ready")
		}
		go publishLoop(base)
	}

	// Phase 1 (AI strategies): advisory deep-analysis engine. Never gates
	// readiness: the heartbeat plane is safety-critical, analysis is not.
	initStrategies()
	if strategyEngine != nil {
		// The operator-state chat block reads the pinned catalog from this
		// process's own read-only route (docs/18 §18.8). Loopback is enough:
		// the handler is served by this mux and never leaves the host.
		opstate.RegistryURL = "http://127.0.0.1:" + port + "/strategies/registry"
	}
	// Observability (plan step 0): a section that is permanently unreachable in
	// production must be visible in the log, not silently absent from the
	// prompt. Only fires when something failed.
	opstate.LogUnavailable = func(missing []string) {
		log.Printf("opstate: unavailable sections: %s", strings.Join(missing, ", "))
	}

	// E03-T01: the trigger loop (ACTIVE set → live ticks → watch edge → Worker).
	// Also advisory-adjacent: a dead feed degrades evaluation, it never gates
	// readiness (the heartbeat stays the safety-critical plane).
	initTriggerLoop(base)

	// Skill engine (advisory): native Go skills registered once at startup.
	skillReg := skills.NewRegistry()
	skills.RegisterBuiltins(skillReg)
	skillRouter := skills.NewRouter(skillReg)
	fmt.Fprintf(os.Stderr, "skills: engine ready (%d builtins)\\n", len(skillReg.List()))

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { fmt.Fprintln(w, "ok") })
	mux.HandleFunc("/analyze", serveAnalyze)
	// Pinned-WASM catalog for the dashboard library tab (advisory, read-only).
	mux.HandleFunc("/strategies/registry", serveRegistry)
	// Skill facade: POST /skills/{name} → native Go skill engine.
	mux.HandleFunc("/skills/{name}", skills.HandleRoute(skillRouter))
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		if !ready.Load() {
			w.WriteHeader(http.StatusServiceUnavailable)
			fmt.Fprintln(w, "not-ready: "+reason())
			return
		}
		fmt.Fprintln(w, "ready")
	})
	if base != "" {
		// CHAT_ORIGINS is a comma-separated WebSocket Origin allow-list; unset
		// (local dev) accepts any Origin.
		var origins []string
		for _, o := range strings.Split(os.Getenv("CHAT_ORIGINS"), ",") {
			if o = strings.TrimSpace(o); o != "" {
				origins = append(origins, o)
			}
		}
		// Market = the live price context every turn carries to the model
		// (Redis last-tick, then Toobit/Binance REST). Bounded + fail-soft
		// inside prices.Fetch: an empty snapshot renders an explicit
		// "unavailable" system line instead of blocking the turn.
		market := func(ctx context.Context, texts ...string) string {
			return prices.FetchAndRender(ctx, texts...)
		}
		// State = the operator context: armed watches, latest analyses, open
		// approvals, order intents, positions, active strategy config — read
		// from our own control plane (read-only GETs, never an order). Without
		// it the model can quote a price but cannot know the book.
		state := func(ctx context.Context, texts ...string) string {
			return opstate.FetchAndRender(ctx, base, texts...)
		}
		s := &chat.Service{Store: chat.NewStore(), AI: chat.NewAIClient(base), Market: market, State: state, Origins: origins}
		mux.Handle("/api/chat/", s)
		mux.Handle("/ws/chat/", s)
	}

	mux.HandleFunc("/metrics", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprintf(w, "active_watches=%d snapshot_at=%v\n", activeN.Load(), snapshotAt.Load())
		_, _ = w.Write([]byte(counters.Render()))
		_, _ = w.Write([]byte(tgMetrics()))
	})
	// Telegram signals: advisory read API + optional embedded userbot.
	initTg()
	mountTg(mux)
	_ = http.ListenAndServe(":"+port, mux)
}

func reason() string {
	if s, ok := readyWhy.Load().(string); ok {
		return s
	}
	return "unknown"
}

// coldStart loads the ACTIVE watch set from D1 (via Workers) into Redis so the
// trigger loop can resume from D1 truth (§6.2 S2 reload path).
func coldStart(base string) error {
	p, err := snapshot.Fetch(base, snapshotTimeout)
	if err != nil {
		return err
	}
	if _, err := redisx.Do("DEL", "watch:active-ids"); err != nil {
		return fmt.Errorf("redis: %w", err)
	}
	// An empty ACTIVE set is a valid cold-start state (fresh paper deploy has
	// no watches yet): DEL alone is the reload. SADD with zero members is a
	// Redis protocol error, so it must be skipped (E12-T01 remote-D1 find).
	if len(p.Watches) == 0 {
		activeN.Store(0)
		counters.Reloads.Add(1)
		return nil
	}
	args := []string{"SADD", "watch:active-ids"}
	for _, w := range p.Watches {
		args = append(args, w.ID)
	}
	if _, err := redisx.Do(args...); err != nil {
		return fmt.Errorf("redis: %w", err)
	}
	activeN.Store(int64(len(p.Watches)))
	counters.Reloads.Add(1)
	return nil
}

// publishLoop sends the §6.1 heartbeat every 5s. A Redis outage is reported in
// the payload (redis_reachable=false) and drops /readyz to 503 — the Workers cron
// then shows the redis component as LAG (§6.2 S2). Readiness is restored by the
// next reachable beat through the same cold-start reload path.
func publishLoop(base string) {
	t := time.NewTicker(heartbeat.Cadence)
	defer t.Stop()
	for now := range t.C {
		p := collect(now)
		if !p.RedisReachable {
			ready.Store(false)
			readyWhy.Store("not-ready: redis unreachable")
		} else if !ready.Load() {
			if err := coldStart(base); err == nil {
				ready.Store(true)
				readyWhy.Store("ready")
			} else {
				readyWhy.Store("not-ready: " + err.Error())
			}
		}
		if err := heartbeat.Post(base, p, 3*time.Second); err != nil {
			fmt.Fprintln(os.Stderr, "heartbeat:", err)
		}
	}
}

// collect builds one heartbeat payload, parsing the stream lag from Redis.
func collect(now time.Time) heartbeat.Payload {
	lastID, err := lastStreamID()
	if err != nil {
		return heartbeat.Build(now, 0, false)
	}
	lag := heartbeat.LagMs(now, lastID)
	counters.ObserveLag(lag)
	return heartbeat.Build(now, lag, true)
}

// lastStreamID reads the newest entry ID of the watch stream. An empty stream is
// not an error: the production producer lands with the later Streams loop.
func lastStreamID() (string, error) {
	items, err := redisx.DoArray("XREVRANGE", stream.StreamWatch, "+", "-", "COUNT", "1")
	if err != nil {
		return "", err
	}
	if len(items) == 0 {
		return "", nil
	}
	return items[0], nil
}

// setChatPathValue stores a route parameter in the request context so that
// r.PathValue(key) works inside handler functions. The Go 1.22 ServeMux
// does this automatically when patterns contain {key}; since we dispatch
// manually here we do it ourselves.
type chatPathKey struct{ name string }

var idKey = chatPathKey{"id"}

func setChatPathValue(r *http.Request, key, value string) *http.Request {
	ctx := context.WithValue(r.Context(), key, value)
	return r.WithContext(ctx)
}
