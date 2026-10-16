// triggerloop_endpoint.go — E03-T01 wiring: the ACTIVE set is evaluated against
// live ticks and every edge is handed to the Worker (the D1 owner).
//
// WHY: trigger.Eval + normalize + conn were complete and tested, but nothing
// joined them, so an ACTIVE watch was never evaluated. This file is that join:
//
//	snapshot (10s reload) → triggerloop.Set(defs)
//	tickfeed (WS or REST) → triggerloop.Apply(tick) → Fire
//	Fire → POST {WORKERS_URL}/api/watches:trigger → D1 (transition + event + outbox)
//
// The Go plane still never writes D1 (E03-T01 out_of_scope): the Worker route
// owns the transaction, the FSM guard and the dedupe. A refusal is counted, not
// retried forever — the next snapshot reload reconciles the local set with D1.
//
// Feed choice (TRIGGER_FEED=rest|ws, default rest): REST is the ADR-004 path
// (one weight-1 request per symbol per round, works everywhere); WS is the
// production feed (conn builders, reconnect, Redis last-tick publish). Both
// carry live venue prices — neither invents a tick.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	"trading-agent/go-watcher/normalize"
	"trading-agent/go-watcher/snapshot"
	"trading-agent/go-watcher/tickfeed"
	"trading-agent/go-watcher/trigger"
	"trading-agent/go-watcher/triggerloop"
)

// reloadInterval re-reads the ACTIVE set; 10s keeps a freshly stalked watch
// armed quickly without hammering D1 (one indexed SELECT per tick).
const reloadInterval = 10 * time.Second

// fireTimeout bounds one POST to the Worker (the transition + analysis run).
const fireTimeout = 30 * time.Second

// agentToken is the shared secret the Worker checks on agent routes. It falls
// back to the heartbeat token so a single deployment secret covers both.
func agentToken() string {
	if t := os.Getenv("GO_AGENT_TOKEN"); t != "" {
		return t
	}
	return os.Getenv("GO_HEARTBEAT_TOKEN")
}

// feedSource picks the tick source (TRIGGER_FEED=rest|ws; rest is the default
// because it needs no long-lived socket).
func feedSource() tickfeed.Source {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("TRIGGER_FEED"))) {
	case "ws":
		w := tickfeed.WS{URL: os.Getenv("TOOBIT_WS_URL")}
		// Publish the last tick where the repo says it lives (px:{sym}), so the
		// chat market context serves WS-sourced prices instead of a REST poll.
		if os.Getenv("REDIS_URL") != "" || os.Getenv("REDIS_HOST") != "" {
			w.Publish = tickfeed.PublishRedis
		}
		return w
	default:
		return tickfeed.REST{}
	}
}

// initTriggerLoop starts the evaluation loop (no-op without WORKERS_URL: the
// snapshot comes from the Worker, so there is nothing to evaluate).
func initTriggerLoop(base string) {
	if base == "" {
		return
	}
	go triggerLoop(base)
}

func triggerLoop(base string) {
	engine := triggerloop.New()
	var cancelFeed context.CancelFunc
	activeKey := ""

	reload := func() {
		p, err := snapshot.Fetch(base, snapshotTimeout)
		if err != nil {
			// Keep the last known set: an unreadable snapshot is not a reason to
			// stop evaluating what D1 last said was ACTIVE.
			counters.FireErrors.Add(1)
			fmt.Fprintln(os.Stderr, "triggerloop: snapshot:", err)
			return
		}
		defs := make([]trigger.Definition, 0, len(p.Watches))
		for _, w := range p.Watches {
			defs = append(defs, trigger.Definition{
				ID: w.ID, Symbol: normalize.ToCanonical(w.Symbol),
				TriggerJSON: w.TriggerJSON, InvalJSON: w.InvalidationJSON, Version: w.Version,
			})
		}
		engine.Set(defs)
		counters.Reloads.Add(1)

		symbols := engine.Symbols()
		sort.Strings(symbols)
		key := strings.Join(symbols, ",")
		if key == activeKey {
			return
		}
		activeKey = key
		if cancelFeed != nil {
			cancelFeed()
			cancelFeed = nil
		}
		if key == "" {
			return // nothing ACTIVE: a feed with nothing to watch
		}
		ctx, cancel := context.WithCancel(context.Background())
		cancelFeed = cancel
		go runFeed(ctx, base, engine, symbols)
	}

	reload()
	t := time.NewTicker(reloadInterval)
	defer t.Stop()
	for range t.C {
		reload()
	}
}

// runFeed streams ticks into the engine and fires each edge at the Worker.
func runFeed(ctx context.Context, base string, engine *triggerloop.Engine, symbols []string) {
	src := feedSource()
	sink := &fireSink{base: base, token: agentToken(), client: &http.Client{Timeout: fireTimeout}}
	fmt.Fprintf(os.Stderr, "triggerloop: %s feed watching %s\n", src.Name(), strings.Join(symbols, ","))

	err := src.Run(ctx, symbols, func(t normalize.Tick) {
		counters.Evals.Add(1)
		if t.RecvMs > 0 && t.Ts > 0 {
			counters.ObserveLag(t.RecvMs - t.Ts)
		}
		for _, f := range engine.Apply(t) {
			counters.Fires.Add(1)
			// The fire outlives the feed on purpose: a snapshot reload can stop the
			// feed the moment D1 no longer lists the watch, and cancelling an
			// in-flight edge POST would abandon a transition the engine already
			// decided (observed live: "context canceled" while the Worker had in
			// fact applied it).
			fctx, cancel := context.WithTimeout(context.Background(), fireTimeout)
			err := sink.fire(fctx, f)
			cancel()
			if err != nil {
				counters.FireErrors.Add(1)
				fmt.Fprintln(os.Stderr, "triggerloop: fire:", f.WatchID, f.Kind, err)
			}
		}
	})
	if err != nil && ctx.Err() == nil {
		counters.FireErrors.Add(1)
		fmt.Fprintln(os.Stderr, "triggerloop:", src.Name(), "feed stopped:", err)
	}
}

// fireSink posts one edge to POST {base}/api/watches:trigger.
type fireSink struct {
	base   string
	token  string
	client *http.Client
}

func (s *fireSink) fire(ctx context.Context, f triggerloop.Fire) error {
	body, err := json.Marshal(map[string]any{
		"watch_id":      f.WatchID,
		"kind":          string(f.Kind),
		"px":            f.Px,
		"prev_px":       f.PrevPx,
		"seq":           f.Seq,
		"watch_version": f.WatchVersion,
		"symbol":        f.Symbol,
		"ts":            f.At.Format(time.RFC3339),
	})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.base+"/api/watches:trigger", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json")
	if s.token != "" {
		req.Header.Set("x-agent-token", s.token)
	}
	res, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	out, _ := io.ReadAll(io.LimitReader(res.Body, 4<<10))
	if res.StatusCode >= 300 {
		return fmt.Errorf("worker HTTP %d: %s", res.StatusCode, strings.TrimSpace(string(out)))
	}
	return nil
}
