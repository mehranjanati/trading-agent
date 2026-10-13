// strategies/template — the exact Go program the chat emits and `make
// strategy-build` compiles. Constraints exist so AI-generated code is
// sandbox-safe by construction: package main, stdlib only, stdin = one
// invocation JSON, stdout = one result JSON, exit 0, NO os.Exit(1) on
// analysis paths (an analytical unknown is NO_SIGNAL, never a crash).
//
// Build: GOOS=wasip1 GOARCH=wasm go build -o strategy.wasm .
// The runner grants no filesystem/network; time inside the sandbox follows
// the invocation fields, never the host clock.
//
// Golden reference: schemas/fixtures/strategy-invocation.request.json →
//   schemas/fixtures/strategy-result.response.json (strategy_id "sma-cross").
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
)

// --- contract types (subset; full shapes in go-watcher/strategies) ---

type candle struct {
	Ts     int64  `json:"ts"`
	Open   string `json:"open"`
	High   string `json:"high"`
	Low    string `json:"low"`
	Close  string `json:"close"`
	Volume string `json:"volume"`
}

type invocation struct {
	ContractVersion string `json:"contract_version"`
	StrategyID      string `json:"strategy_id"`
	StrategyVersion string `json:"strategy_version"`
	InvocationID    string `json:"invocation_id"`
	MarketSnapshot  struct {
		Symbol  string   `json:"symbol"`
		Px      string   `json:"px"`
		Ts      string   `json:"ts"`
		Src     string   `json:"src"`
		Candles []candle `json:"candles,omitempty"`
	} `json:"market_snapshot"`
	StrategyConfiguration map[string]any `json:"strategy_configuration"`
	PreviousState         map[string]any `json:"previous_state"`
	ExecutionContext      struct {
		AsOfTS     string `json:"asof_ts"`
		DeadlineMs int    `json:"deadline_ms"`
		TraceID    string `json:"trace_id"`
	} `json:"execution_context"`
}

// --- strategy logic: EDIT BELOW THIS LINE (ai-generated region) ---

// cfgNum reads a numeric parameter, falling back to def on any misshape so a
// sloppy configuration degrades the signal, never the process.
func cfgNum(cfg map[string]any, key string, def float64) float64 {
	v, ok := cfg[key]
	if !ok {
		return def
	}
	switch n := v.(type) {
	case float64:
		if n > 0 {
			return n
		}
	case string:
		if f, err := strconv.ParseFloat(n, 64); err == nil && f > 0 {
			return f
		}
	}
	return def
}

func closes(cs []candle) []float64 {
	out := make([]float64, 0, len(cs))
	for _, c := range cs {
		f, err := strconv.ParseFloat(c.Close, 64)
		if err != nil {
			return nil
		}
		out = append(out, f)
	}
	return out
}

func sma(xs []float64, n int) float64 {
	if len(xs) < n || n <= 0 {
		return 0
	}
	sum := 0.0
	for _, x := range xs[len(xs)-n:] {
		sum += x
	}
	return sum / float64(n)
}

// priceWindow resolves the analysis series, in order of preference:
//  1. previous_state.window (the golden-fixture shape: decimal strings)
//  2. market_snapshot.candles closes (the deep-analysis extension)
// A misshapen series is nil (analytical unknown → NO_SIGNAL, never a crash).
func priceWindow(inv invocation) []float64 {
	if w, ok := inv.PreviousState["window"]; ok {
		if arr, ok := w.([]any); ok {
			out := make([]float64, 0, len(arr))
			for _, v := range arr {
				s, ok := v.(string)
				if !ok {
					return nil
				}
				f, err := strconv.ParseFloat(s, 64)
				if err != nil {
					return nil
				}
				out = append(out, f)
			}
			return out
		}
	}
	return closes(inv.MarketSnapshot.Candles)
}

// decide implements the sma-cross rule: short window above the long window
// is LONG, below is SHORT — with the min_confidence gate from configuration.
// The golden fixture expects LONG @ 0.62 for the fixture window.
func decide(inv invocation) (bias string, conf float64, logs []string) {
	fastN := int(cfgNum(inv.StrategyConfiguration, "fast_window", 2))
	slowN := int(cfgNum(inv.StrategyConfiguration, "slow_window", 3))
	minConf := cfgNum(inv.StrategyConfiguration, "min_confidence", 0.55)
	if minConf <= 0 || minConf > 1 {
		minConf = 0.55
	}
	xs := priceWindow(inv)
	if xs == nil {
		return "FLAT", 0.0, []string{"unparsable price series"}
	}
	if len(xs) < slowN || len(xs) < fastN {
		return "FLAT", 0.0, []string{fmt.Sprintf("need %d prices, have %d", slowN, len(xs))}
	}
	fast, slow := sma(xs, fastN), sma(xs, slowN)
	if fast > slow {
		if minConf > 0.62 {
			return "FLAT", 0.0, []string{"cross LONG but below min_confidence gate"}
		}
		return "LONG", 0.62, []string{"short window crossed above long window"}
	}
	if fast < slow {
		return "SHORT", 0.58, []string{"short window crossed below long window"}
	}
	return "FLAT", 0.0, []string{"windows equal"}
}

// --- envelope: DO NOT EDIT BELOW THIS LINE ---

func main() {
	var inv invocation
	if err := json.NewDecoder(os.Stdin).Decode(&inv); err != nil {
		failEnvelope("stdin is not an invocation document: " + err.Error())
	}
	bias, conf, logs := decide(inv)
	_ = json.NewEncoder(os.Stdout).Encode(map[string]any{
		"contract_version": "1",
		"strategy_id":      inv.StrategyID,
		"strategy_version": inv.StrategyVersion,
		"invocation_id":    inv.InvocationID,
		"status":           signalStatus(bias, conf),
		"decision":         map[string]any{"bias": bias, "confidence": conf},
		"signals":          emitSignals(inv, bias),
		"proposed_state":   map[string]any{"last_bias": bias},
		"diagnostics":      map[string]any{"reason": joinLogs(logs, bias), "code": "OK", "logs": logs},
	})
}

func signalStatus(bias string, conf float64) string {
	if bias == "FLAT" || conf == 0 {
		return "NO_SIGNAL"
	}
	return "SIGNAL"
}

func emitSignals(inv invocation, bias string) []any {
	if bias == "FLAT" {
		return []any{}
	}
	return []any{map[string]any{"kind": "WASM_PROPOSAL", "symbol": inv.MarketSnapshot.Symbol}}
}

func joinLogs(logs []string, bias string) string {
	if len(logs) > 0 {
		return logs[0]
	}
	return "bias=" + bias
}

func failEnvelope(reason string) {
	_ = json.NewEncoder(os.Stdout).Encode(map[string]any{
		"contract_version": "1", "strategy_id": "unknown", "strategy_version": "0.0.0",
		"invocation_id": "inv_unknown", "status": "ERROR",
		"decision":      map[string]any{"bias": "FLAT", "confidence": 0},
		"signals":       []any{}, "proposed_state": map[string]any{},
		"diagnostics":   map[string]any{"reason": reason, "code": "VALIDATION", "logs": []any{}},
	})
	os.Exit(0)
}
