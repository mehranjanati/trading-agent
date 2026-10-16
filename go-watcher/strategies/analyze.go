// Analyze endpoint wiring: POST /analyze and strategy plumbing for the
// watcher mux. /analyze is the deep-analysis engine (Phase 1): it fetches
// real klines per timeframe, builds one E13 invocation per (strategy, tf),
// runs each under wazero, and aggregates. The response carries per-strategy
// results plus the aggregate verdict and suggested watch zones from ATR.
// Everything here is advisory — it writes no approvals, no orders, no D1.
package strategies

import (
	"encoding/json"
	"net/http"
	"sync/atomic"
)

// validTFs is the deep-analysis timeframe set.
var validTFs = map[string]bool{"15m": true, "1h": true, "4h": true}

// AnalyzeRequest is the POST /analyze body.
type AnalyzeRequest struct {
	Symbol     string            `json:"symbol"`
	Direction  string            `json:"direction"`
	Timeframes []string          `json:"timeframes"`
	Strategies []StrategyRequest `json:"strategies"`
	Position   *PositionContext  `json:"position,omitempty"`
}

// StrategyRequest pins one strategy version ("" version = latest).
type StrategyRequest struct {
	ID      string         `json:"id"`
	Version string         `json:"version"`
	Config  map[string]any `json:"config,omitempty"`
}

// PositionContext frames an EXISTING position: entry/size/leverage ride along
// for risk-distance math (invalidation gap, liquidation distance).
type PositionContext struct {
	Entry    string  `json:"entry"`
	Size     string  `json:"size"`
	Leverage float64 `json:"leverage"`
}

// StrategyVerdict is one (strategy, timeframe) execution.
type StrategyVerdict struct {
	StrategyID      string `json:"strategy_id"`
	StrategyVersion string `json:"strategy_version"`
	StrategySHA256  string `json:"strategy_sha256"`
	Timeframe       string `json:"timeframe"`
	InvocationID    string `json:"invocation_id"`
	InputHash       string `json:"input_hash"`
	Result          Result `json:"result"`
	DataSource      string `json:"data_source"`
}

// AnalyzeResponse is the POST /analyze envelope.
type AnalyzeResponse struct {
	ID           string           `json:"id"`
	Symbol       string           `json:"symbol"`
	At           string           `json:"at"`
	Aggregate    AggregateVerdict `json:"aggregate"`
	Verdicts     []StrategyVerdict `json:"verdicts"`
	SuggestZones SuggestedZones   `json:"suggest_zones"`
}

// AggregateVerdict is the cross-strategy rollup. Advisory only: it never
// approves, never submits — approvals stay human (E08-T02).
type AggregateVerdict struct {
	Bias        string  `json:"bias"`
	Confidence  float64 `json:"confidence"`
	Agree       int     `json:"agree"`
	Disagree    int     `json:"disagree"`
	Flat        int     `json:"flat"`
	Errors      int     `json:"errors"`
	N           int     `json:"n"`
	Explanation string  `json:"explanation"`
}

// SuggestedZones are ATR-derived trigger/invalidation candidates the
// dashboard can one-click into the watch form. The provenance fields ride
// along (provider, bar count, the newest close and its bar time) so a trigger
// price is never shown without the venue it was measured on: Toobit is the
// trading venue, but a symbol Toobit does not list (e.g. CELR) falls through
// to OKX/Binance, and a zone measured on another venue must be readable as
// such before a human stalks it.
type SuggestedZones struct {
	Timeframe    string `json:"timeframe"`
	Source       string `json:"source,omitempty"`
	Bars         int    `json:"bars"`
	Last         string `json:"last,omitempty"`
	LastTS       string `json:"last_ts,omitempty"`
	ATR          string `json:"atr"`
	TriggerLong  string `json:"trigger_long"`
	InvalLong    string `json:"inval_long"`
	TriggerShort string `json:"trigger_short"`
	InvalShort   string `json:"inval_short"`
}

var analyzeSeq atomic.Int64

// Engine wires registry + runner for the mux.
type Engine struct {
	reg    *Registry
	runner *Runner
	base   string // WORKERS_URL (push of runs happens in Phase 2)
}

// NewEngine builds the analysis engine. base may be "" (no push).
func NewEngine(reg *Registry, runner *Runner, base string) *Engine {
	return &Engine{reg: reg, runner: runner, base: base}
}

func mergeConfig(base, over map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range base {
		out[k] = v
	}
	for k, v := range over {
		out[k] = v
	}
	return out
}

func sanitize(s string) string {
	b := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' {
			b = append(b, c)
		}
	}
	if len(b) == 0 {
		return "x"
	}
	return string(b)
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		return []byte("{}")
	}
	return b
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeAnalyzeErr(w http.ResponseWriter, code int, errCode, msg string) {
	writeJSON(w, code, map[string]any{"code": errCode, "message": msg})
}
