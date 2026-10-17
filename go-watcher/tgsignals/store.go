// Store + HTTP seam for tgsignals (stdlib-only).
//
// The Store persists accepted signals to Redis using the repo's redisx seam
// (plain RESP, no client dep): LPUSH history list (trimmed) + SET latest +
// XADD live stream. Sink is the in-process fan-in the gotd runner calls;
// Endpoint serves the read API the dashboard/operator uses.
package tgsignals

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"trading-agent/go-watcher/redisx"
)

// RedisDo is injectable for tests (redisx.Do when nil).
var RedisDo = func(args ...string) (string, error) { return redisx.Do(args...) }

// RedisDoArray is injectable for tests (redisx.DoArray when nil).
var RedisDoArray = func(args ...string) ([]string, error) { return redisx.DoArray(args...) }

// Sink is the in-process fan-in: dedupes by bot+msgID, persists to Redis,
// and counts accepts/dupes for /metrics. The gotd runner calls Ingest for
// every message that arrives from the allow-listed bot(s).
type Sink struct {
	mu     sync.Mutex
	seen   map[string]struct{}
	Accept int64
	Dupes  int64
	Errors int64
	Last   Signal
	Has    bool
}

// NewSink returns an empty sink.
func NewSink() *Sink { return &Sink{seen: map[string]struct{}{}} }

// Ingest parses raw bot text and persists the signal. A text that is not a
// setup is a skip (nil signal, nil error) — never a synthetic row.
// A repeated bot+msgID is a dupe (counted, not re-stored).
func (s *Sink) Ingest(bot, text string, msgID int, dateUnix int64) (*Signal, error) {
	sig, err := Parse(bot, text, msgID, dateUnix, time.Now())
	if err != nil {
		return nil, nil // not a setup — skip silently
	}
	key := fmt.Sprintf("%s:%d", sig.Bot, sig.MsgID)
	s.mu.Lock()
	if _, ok := s.seen[key]; ok && sig.MsgID != 0 {
		s.Dupes++
		s.mu.Unlock()
		return nil, nil
	}
	s.seen[key] = struct{}{}
	if len(s.seen) > 4096 {
		s.seen = map[string]struct{}{key: {}}
	}
	s.Accept++
	s.Last = sig
	s.Has = true
	s.mu.Unlock()

	if err := Persist(sig); err != nil {
		s.mu.Lock()
		s.Errors++
		s.mu.Unlock()
		return nil, err
	}
	return &sig, nil
}

// Persist writes one signal to Redis: LPUSH+LTRIM history, SET latest,
// XADD live stream. A Redis outage is an error to the caller (the runner
// logs it) — chat/signals are advisory, they never gate readiness.
func Persist(sig Signal) error {
	raw, err := json.Marshal(sig)
	if err != nil {
		return err
	}
	bot := sig.Bot
	if bot == "" {
		bot = BotUsername
	}
	if _, err := RedisDo("LPUSH", ListKey(bot), string(raw)); err != nil {
		return err
	}
	if _, err := RedisDo("LTRIM", ListKey(bot), "0", fmt.Sprintf("%d", HistoryLen-1)); err != nil {
		return err
	}
	if _, err := RedisDo("SET", LatestKey(bot), string(raw)); err != nil {
		return err
	}
	streamID, _ := RedisDo("XADD", StreamSignals, "MAXLEN", "~", "10000", "*",
		"bot", bot, "symbol", sig.Symbol, "canonical", sig.Canonical,
		"exchange", sig.Exchange, "timeframe", sig.Timeframe,
		"data", string(raw))
	_ = streamID
	return nil
}

// Latest reads the newest stored signal for a bot ("{}" when none).
func Latest(bot string) (string, error) {
	out, err := RedisDo("GET", LatestKey(bot))
	if err != nil {
		return "", err
	}
	if out == "" {
		return "{}", nil
	}
	return out, nil
}

// History reads up to n newest signals for a bot (JSON array, newest first).
func History(bot string, n int) (string, error) {
	if n <= 0 || n > HistoryLen {
		n = 20
	}
	items, err := RedisDoArray("LRANGE", ListKey(bot), "0", fmt.Sprintf("%d", n-1))
	if err != nil {
		return "", err
	}
	return "[" + strings.Join(items, ",") + "]", nil
}

// Endpoint serves GET /api/tg/signals?bot=&n= (history) and
// GET /api/tg/signals:latest?bot= (latest). Advisory read-only routes.
type Endpoint struct{ Sink *Sink }

func writeJSON(w http.ResponseWriter, code int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(code)
	_, _ = w.Write([]byte(body))
}

// ServeHTTP dispatches the read API.
func (e *Endpoint) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	bot := strings.TrimSpace(r.URL.Query().Get("bot"))
	if bot == "" {
		bot = BotUsername
	}
	switch {
	case strings.HasSuffix(r.URL.Path, ":latest") && r.Method == "GET":
		out, err := Latest(bot)
		if err != nil {
			writeJSON(w, 503, `{"code":"TG_UNAVAILABLE","message":"redis unavailable"}`)
			return
		}
		writeJSON(w, 200, out)
	case r.URL.Path == "/api/tg/signals" && r.Method == "GET":
		n := 20
		if q := strings.TrimSpace(r.URL.Query().Get("n")); q != "" {
			var v int
			if _, err := fmt.Sscanf(q, "%d", &v); err == nil && v > 0 {
				n = v
			}
		}
		out, err := History(bot, n)
		if err != nil {
			writeJSON(w, 503, `{"code":"TG_UNAVAILABLE","message":"redis unavailable"}`)
			return
		}
		writeJSON(w, 200, out)
	default:
		http.NotFound(w, r)
	}
}
