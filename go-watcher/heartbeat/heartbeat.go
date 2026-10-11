// Package heartbeat — E06-T02-W0.1: Go liveness publisher for the Workers health
// cron. Cadence 5s, UNHEALTHY after 3 misses = 15s (docs/06-failover-and-recovery.md
// §6.1). Transport: POST {WORKERS_URL}/api/health:heartbeat (Workers route, W0.2);
// the payload keys are asserted from both sides (heartbeat_test.go and
// health-heartbeat.test.mjs) so a rename cannot silently break the cron.
package heartbeat

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Cadence is the §6.1 heartbeat interval.
const Cadence = 5 * time.Second

// Path is the Workers route that ingests the heartbeat.
const Path = "/api/health:heartbeat"

// Payload is the JSON body of POST /api/health:heartbeat.
type Payload struct {
	GoHeartbeatMs  int64 `json:"go_heartbeat_ms"`
	StreamLagMs    int64 `json:"stream_lag_ms"`
	RedisReachable bool  `json:"redis_reachable"`
}

// Build assembles the payload for one tick.
func Build(now time.Time, streamLagMs int64, redisReachable bool) Payload {
	return Payload{GoHeartbeatMs: now.UnixMilli(), StreamLagMs: streamLagMs, RedisReachable: redisReachable}
}

// LagMs derives stream lag from a Redis Streams entry ID ("<ms>-<seq>").
// An empty ID (stream has no entries yet) → 0: there is no observable lag, so a
// fresh paper system is not falsely degraded. Malformed or future-dated → -1
// (unknown) rather than a misleading number.
func LagMs(now time.Time, lastID string) int64 {
	if lastID == "" {
		return 0
	}
	msPart, _, ok := strings.Cut(lastID, "-")
	if !ok {
		return -1
	}
	ms, err := strconv.ParseInt(msPart, 10, 64)
	if err != nil || ms <= 0 {
		return -1
	}
	lag := now.UnixMilli() - ms
	if lag < 0 {
		return -1
	}
	return lag
}

// Post ships one payload to the Workers plane. The timeout is bounded: a stalled
// Workers plane must never block the watcher loop — the cron treats a stale
// heartbeat as degraded on its own.
func Post(baseURL string, p Payload, timeout time.Duration) error {
	if timeout <= 0 {
		timeout = 3 * time.Second
	}
	body, err := json.Marshal(p)
	if err != nil {
		return err
	}
	url := strings.TrimRight(baseURL, "/") + Path
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json")
	resp, err := (&http.Client{Timeout: timeout}).Do(req)
	if err != nil {
		return fmt.Errorf("heartbeat: post: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("heartbeat: status %d", resp.StatusCode)
	}
	return nil
}
