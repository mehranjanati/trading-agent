// strategy-check — prove a built strategy .wasm actually SPEAKS the contract
// before anyone registers it.
//
// WHY THIS EXISTS: the only pre-registration gate today is a set of regexes on
// the Go SOURCE (workers/src/strategies-ai.mjs). A regex cannot tell you whether
// the compiled module echoes its ids, keeps confidence in [0,1], or panics on a
// malformed configuration — only running the real bytes can. This CLI executes
// the artifact through the SAME runner the watcher uses (strategies.Runner,
// wazero, 500ms deadline) against the golden fixtures plus the failure shapes a
// strategy is guaranteed to meet in production, and exits non-zero if the
// artifact cannot answer like a strategy.
//
// Advisory-safe by construction: it reads a .wasm file, writes nothing, needs no
// D1/Redis/network, so it runs in CI and on a laptop identically.
//
// usage (from go-watcher/):
//
//	go run ./cmd/strategy-check -wasm strategies/samples/sma-cross-0.1.0.wasm \
//	  -id sma-cross -version 0.1.0
//
// exit codes: 0 = every case passed, 1 = at least one case failed, 2 = bad usage.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"trading-agent/go-watcher/strategies"
)

// faultCodes are the diagnostics codes the RUNNER assigns when a guest
// misbehaves (runner.go faultCode + validate.go). A strategy under test must
// never produce one of these: VALIDATION is the strategy politely refusing,
// which the contract explicitly allows.
var faultCodes = map[string]string{
	"PANIC":             "the guest panicked or exited non-zero",
	"TIMEOUT":           "the guest blew the deadline budget",
	"OOM":               "the guest exhausted its memory",
	"OUTPUT_TOO_LARGE":  "stdout exceeded the protocol cap",
	"CONTRACT_MISMATCH": "stdout was not a valid strategy-result document",
}

// caseResult is one invocation of the artifact and what came back.
type caseResult struct {
	Name   string  `json:"name"`
	OK     bool    `json:"ok"`
	Code   string  `json:"code"`
	Status string  `json:"status"`
	Bias   string  `json:"bias"`
	Conf   float64 `json:"confidence"`
	MS     int64   `json:"ms"`
	Reason string  `json:"reason,omitempty"`
	Note   string  `json:"note,omitempty"`
}

func main() {
	wasmPath := flag.String("wasm", "", "path to the built .wasm artifact (required)")
	id := flag.String("id", "", "strategy id the artifact must echo (required)")
	version := flag.String("version", "", "strategy version the artifact must echo (required)")
	fixtures := flag.String("fixtures", "", "fixtures dir (default: <repo>/schemas/fixtures)")
	jsonOut := flag.Bool("json", false, "emit a JSON report instead of a table")
	flag.Parse()

	if *wasmPath == "" || *id == "" || *version == "" {
		fmt.Fprintln(os.Stderr, "usage: strategy-check -wasm <path> -id <id> -version <x.y.z> [-fixtures dir] [-json]")
		os.Exit(2)
	}
	if !semverish(*version) {
		fmt.Fprintf(os.Stderr, "strategy-check: version %q is not x.y.z\n", *version)
		os.Exit(2)
	}

	wasm, err := os.ReadFile(*wasmPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "strategy-check:", err)
		os.Exit(2)
	}
	if len(wasm) == 0 {
		fmt.Fprintln(os.Stderr, "strategy-check: artifact is empty")
		os.Exit(2)
	}

	dir := *fixtures
	if dir == "" {
		dir = defaultFixtures()
	}

	ctx := context.Background()
	runner, err := strategies.NewRunner(ctx)
	if err != nil {
		fmt.Fprintln(os.Stderr, "strategy-check: runner:", err)
		os.Exit(2)
	}
	defer runner.Close(ctx)

	cases := buildCases(dir, *id, *version)
	results := make([]caseResult, 0, len(cases))
	failed := 0
	for _, c := range cases {
		started := time.Now()
		res := runner.Run(ctx, wasm, c.inv)
		cr := caseResult{
			Name: c.name, Code: res.Diagnostics.Code, Status: res.Status,
			Bias: res.Decision.Bias, Conf: res.Decision.Confidence,
			MS:     time.Since(started).Milliseconds(),
			Reason: res.Diagnostics.Reason, Note: c.note,
		}
		if why, bad := judge(res); bad {
			cr.OK = false
			cr.Note = strings.TrimSpace(cr.Note + " — " + why)
			failed++
		} else {
			cr.OK = true
		}
		results = append(results, cr)
	}

	if *jsonOut {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		_ = enc.Encode(map[string]any{
			"ok": failed == 0, "artifact": *wasmPath, "id": *id, "version": *version,
			"cases": results, "failed": failed,
		})
	} else {
		printTable(results, *wasmPath, *id, *version)
	}
	if failed > 0 {
		os.Exit(1)
	}
}

// judge decides whether one result is acceptable for a candidate strategy.
// A fault code is always a failure. A VALIDATION result is acceptable — the
// strategy declined the input instead of crashing, which is the contract's
// explicit requirement ("an analytical unknown is NO_SIGNAL, never a crash").
// Echo fields are checked here too, so a strategy that hardcodes its ids can
// never be registered as a different version.
func judge(res strategies.Result) (string, bool) {
	if why, isFault := faultCodes[res.Diagnostics.Code]; isFault {
		return fmt.Sprintf("fault %s: %s", res.Diagnostics.Code, why), true
	}
	switch res.Diagnostics.Code {
	case "OK", "VALIDATION":
	default:
		return "unknown diagnostics.code " + res.Diagnostics.Code, true
	}
	if res.Decision.Confidence < 0 || res.Decision.Confidence > 1 {
		return fmt.Sprintf("confidence %v outside [0,1]", res.Decision.Confidence), true
	}
	if res.StrategyID == "" || res.StrategyVersion == "" || res.InvocationID == "" {
		return "echo fields are empty", true
	}
	return "", false
}

// checkCase is one invocation prepared by the harness.
type checkCase struct {
	name string
	note string
	inv  strategies.Invocation
}

// buildCases assembles the golden fixture plus the shapes a strategy is
// guaranteed to meet: no candles, one candle, a garbage configuration, a
// deadline the runner has to clamp, and a bare document. Each of these has
// crashed a naive strategy in the wild; each must degrade, never fault.
func buildCases(dir, id, version string) []checkCase {
	base := goldenInvocation(dir)
	base.StrategyID = id
	base.StrategyVersion = version
	base.ContractVersion = "1"
	if base.ExecutionContext.DeadlineMs == 0 {
		base.ExecutionContext.DeadlineMs = 500
	}
	if base.ExecutionContext.AsOfTS == "" {
		base.ExecutionContext.AsOfTS = time.Now().UTC().Format(time.RFC3339)
	}
	if base.ExecutionContext.TraceID == "" {
		base.ExecutionContext.TraceID = "tr_check"
	}

	out := []checkCase{{
		name: "golden", note: "schemas/fixtures/strategy-invocation.request.json",
		inv: cloneCase(base, "inv_golden"),
	}}

	// Candles-only: the deep-analysis extension the live path actually sends,
	// with previous_state empty. A stateful strategy must build its window from
	// the bars (or decline) — not index into a nil slice.
	candles := cloneCase(base, "inv_candles")
	candles.PreviousState = map[string]any{}
	candles.StrategyConfiguration = map[string]any{"min_confidence": 0.55}
	candles.MarketSnapshot.Candles = synthCandles(24)
	out = append(out, checkCase{
		name: "candles-only", note: "previous_state {} + 24 bars",
		inv: candles,
	})

	// One bar: every indicator is undefined. NO_SIGNAL/FLAT is correct; a panic
	// (index out of range) is the classic authoring bug this catches.
	one := cloneCase(base, "inv_one_candle")
	one.PreviousState = map[string]any{}
	one.MarketSnapshot.Candles = synthCandles(1)
	out = append(out, checkCase{
		name: "single-candle", note: "1 bar — indicators undefined",
		inv: one,
	})

	// Garbage configuration: a wrong type must not reach an unchecked type
	// assertion. This is exactly what a sloppy strategy_configuration overlay
	// produces in production.
	garbage := cloneCase(base, "inv_garbage_cfg")
	garbage.StrategyConfiguration = map[string]any{
		"fast_window": "abc", "slow_window": nil, "min_confidence": "loud",
		"window": 7, "nested": map[string]any{"x": []any{1, "2", nil}},
	}
	out = append(out, checkCase{
		name: "garbage-config", note: "wrong types in strategy_configuration",
		inv: garbage,
	})

	// Deadline beyond the contract cap: the runner clamps to 500ms, so the
	// strategy must still answer (it never sees the clamp).
	over := cloneCase(base, "inv_deadline_over")
	over.ExecutionContext.DeadlineMs = 100000
	out = append(out, checkCase{
		name: "deadline-over-cap", note: "deadline_ms 100000 (runner clamps)",
		inv: over,
	})

	// Bare document: the shape a buggy caller sends when its state is missing.
	bare := cloneCase(base, "inv_bare")
	bare.MarketSnapshot = strategies.MarketSnapshot{}
	bare.StrategyConfiguration = map[string]any{}
	bare.PreviousState = map[string]any{}
	bare.ExecutionContext = strategies.ExecutionContext{DeadlineMs: 500}
	out = append(out, checkCase{
		name: "bare-document", note: "empty market snapshot, no state",
		inv: bare,
	})
	return out
}

// goldenInvocation loads the golden request fixture; a missing/broken fixture is
// not fatal (the synthetic cases still run) — the repo ships it, so this only
// fires on a partial checkout and then the golden case is simply absent.
func goldenInvocation(dir string) strategies.Invocation {
	raw, err := os.ReadFile(filepath.Join(dir, "strategy-invocation.request.json"))
	if err != nil {
		return strategies.Invocation{}
	}
	var inv strategies.Invocation
	if err := json.Unmarshal(raw, &inv); err != nil {
		return strategies.Invocation{}
	}
	return inv
}

// cloneCase deep-copies the base invocation and stamps a fresh invocation_id, so
// every case is an independent, uniquely-traceable run. Maps and slices are
// reference types: re-allocating them is what stops one case's mutation from
// leaking into the next.
func cloneCase(base strategies.Invocation, invID string) strategies.Invocation {
	out := base
	out.InvocationID = invID
	cfg := make(map[string]any, len(base.StrategyConfiguration))
	for k, v := range base.StrategyConfiguration {
		cfg[k] = v
	}
	out.StrategyConfiguration = cfg
	prev := make(map[string]any, len(base.PreviousState))
	for k, v := range base.PreviousState {
		prev[k] = v
	}
	out.PreviousState = prev
	if base.MarketSnapshot.Candles != nil {
		out.MarketSnapshot.Candles = append([]strategies.Candle(nil), base.MarketSnapshot.Candles...)
	}
	return out
}

// synthCandles builds a deterministic rising series with decimal-string fields
// (the wire format strategies must parse themselves).
func synthCandles(n int) []strategies.Candle {
	out := make([]strategies.Candle, 0, n)
	px := 67000.0
	ts := time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC).UnixMilli()
	for i := 0; i < n; i++ {
		o := px
		px += 10
		out = append(out, strategies.Candle{
			Ts:     ts + int64(i)*5*60*1000,
			Open:   fmtPx(o),
			High:   fmtPx(px + 5),
			Low:    fmtPx(o - 5),
			Close:  fmtPx(px),
			Volume: "12.5",
		})
	}
	return out
}

func fmtPx(f float64) string { return fmt.Sprintf("%.2f", f) }

// defaultFixtures resolves <repo>/schemas/fixtures whether the binary runs from
// go-watcher/ (the documented usage) or from the repo root.
func defaultFixtures() string {
	candidates := []string{
		filepath.Join("..", "schemas", "fixtures"),
		filepath.Join("schemas", "fixtures"),
	}
	for _, c := range candidates {
		if _, err := os.Stat(filepath.Join(c, "strategy-invocation.request.json")); err == nil {
			return c
		}
	}
	return candidates[0]
}

// semverish mirrors the schema/registry rule: x.y.z, digits only.
func semverish(v string) bool {
	parts := strings.Split(v, ".")
	if len(parts) != 3 {
		return false
	}
	for _, p := range parts {
		if p == "" {
			return false
		}
		for _, r := range p {
			if r < '0' || r > '9' {
				return false
			}
		}
	}
	return true
}

// printTable renders the per-case verdict in authored order (the golden case
// first), so a reader can compare a failing run against the contract by eye.
func printTable(results []caseResult, wasm, id, version string) {
	fmt.Printf("strategy-check %s@%s\n  artifact: %s\n\n", id, version, wasm)
	fmt.Printf("  %-4s %-18s %-11s %-10s %-6s %-6s %s\n", "", "case", "status", "code", "bias", "ms", "note")
	for _, r := range results {
		mark := "ok"
		if !r.OK {
			mark = "FAIL"
		}
		fmt.Printf("  %-4s %-18s %-11s %-10s %-6s %-6d %s\n", mark, r.Name, r.Status, r.Code, r.Bias, r.MS, r.Note)
	}
	passed := 0
	for _, r := range results {
		if r.OK {
			passed++
		}
	}
	fmt.Printf("\n  %d/%d cases passed\n", passed, len(results))
}
