// analyze-live — run the pinned strategies against LIVE klines and print the
// provenance-stamped result. WHY IT EXISTS: /analyze answers "what does the
// aggregate say", but an operator reviewing a setup must also be able to answer
// "which venue did that price come from, how many bars, how old". This CLI
// drives the SAME engine path as POST /analyze (registry + wazero runner +
// aggregate + ATR zones over the httptest handler) and prints, per timeframe,
// the provider that answered (toobit-rest | okx-rest | binance-rest), the bar
// count, the newest bar close/time and the ATR zones — so a trigger price can
// never be read without its source. No D1, no orders, no approvals: advisory.
//
// usage (from go-watcher/):
//   go run ./cmd/analyze-live -symbol CELRUSDT -strategies sma-cross@0.1.0
//   go run ./cmd/analyze-live -symbol BTCUSDT            # every pinned strategy
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"time"

	"trading-agent/go-watcher/strategies"
)

func main() {
	symbol := flag.String("symbol", "BTCUSDT", "venue symbol (canonical form, e.g. CELRUSDT)")
	direction := flag.String("direction", "", "optional LONG|SHORT (filters the aggregate's agree/disagree view)")
	timeframes := flag.String("timeframes", "15m,1h,4h", "comma-separated 15m,1h,4h")
	strategyList := flag.String("strategies", "", "comma-separated id@version pins (default: every pinned version)")
	dir := flag.String("dir", "strategies/samples", "STRATEGIES_DIR (registry.json + pinned .wasm)")
	flag.Parse()

	if err := run(*symbol, *direction, *timeframes, *strategyList, *dir); err != nil {
		fmt.Fprintln(os.Stderr, "analyze-live:", err)
		os.Exit(1)
	}
}

func run(symbol, direction, timeframes, strategyList, dir string) error {
	ctx := context.Background()
	runner, err := strategies.NewRunner(ctx)
	if err != nil {
		return err
	}
	defer runner.Close(ctx)
	reg, err := strategies.Open(dir)
	if err != nil {
		return err
	}

	req := map[string]any{
		"symbol":     symbol,
		"timeframes": splitCSV(timeframes),
		"strategies": pins(strategyList, reg.List()),
	}
	if direction != "" {
		req["direction"] = strings.ToUpper(direction)
	}

	// The real handler, not a re-implementation: whatever this prints is what
	// POST /analyze returns.
	engine := strategies.NewEngine(reg, runner, "")
	srv := httptest.NewServer(http.HandlerFunc(engine.ServeAnalyze))
	defer srv.Close()

	body, _ := json.Marshal(req)
	res, err := http.Post(srv.URL, "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("analyze HTTP %d: %s", res.StatusCode, string(raw))
	}
	var out strategies.AnalyzeResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return err
	}

	fmt.Printf("analyze %s  id=%s  at=%s\n", out.Symbol, out.ID, out.At)
	fmt.Printf("aggregate %s @ %v  agree=%d disagree=%d flat=%d errors=%d n=%d\n",
		out.Aggregate.Bias, out.Aggregate.Confidence, out.Aggregate.Agree, out.Aggregate.Disagree,
		out.Aggregate.Flat, out.Aggregate.Errors, out.Aggregate.N)
	fmt.Printf("  %s\n", out.Aggregate.Explanation)

	// Klines provenance: one live fetch per timeframe, reported before any
	// verdict so the source is never ambiguous.
	for _, tf := range splitCSV(timeframes) {
		bars, src, err := strategies.FetchKlines(symbol, tf)
		if err != nil {
			fmt.Printf("klines %-3s UNAVAILABLE  %v\n", tf, err)
			continue
		}
		last := bars[len(bars)-1]
		oldest := bars[0]
		age := time.Since(time.UnixMilli(last.Ts)).Round(time.Second)
		fmt.Printf("klines %-3s source=%-12s bars=%d  oldest=%s newest=%s (age %s)  last_close=%s\n",
			tf, src, len(bars), time.UnixMilli(oldest.Ts).UTC().Format(time.RFC3339),
			time.UnixMilli(last.Ts).UTC().Format(time.RFC3339), age, last.Close)
	}

	fmt.Println("verdicts:")
	for _, v := range out.Verdicts {
		fmt.Printf("  %-12s %-3s src=%-12s %-9s bias=%-5s conf=%.2f  %s\n",
			v.StrategyID+"@"+v.StrategyVersion, v.Timeframe, v.DataSource, v.Result.Status,
			v.Result.Decision.Bias, v.Result.Decision.Confidence, v.Result.Diagnostics.Reason)
	}
	z := out.SuggestZones
	fmt.Printf("zones (%s) source=%s bars=%d last=%s @%s  atr=%s\n",
		z.Timeframe, z.Source, z.Bars, z.Last, z.LastTS, z.ATR)
	fmt.Printf("  long: trigger>= %s inval<= %s  short: trigger<= %s inval>= %s\n",
		z.TriggerLong, z.InvalLong, z.TriggerShort, z.InvalShort)
	if z.Source != "" && z.Source != "toobit-rest" {
		fmt.Printf("  NOTE: zone data is from %s, not the Toobit trading venue — verify the symbol is listed there before stalking\n", z.Source)
	}
	return nil
}

func splitCSV(s string) []string {
	out := []string{}
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// pins resolves -strategies (id@version list) or falls back to every pinned
// version in the registry — the catalog the runner can actually execute.
func pins(list string, entries []strategies.Entry) []map[string]any {
	out := []map[string]any{}
	if strings.TrimSpace(list) != "" {
		for _, p := range splitCSV(list) {
			id, version, _ := strings.Cut(p, "@")
			out = append(out, map[string]any{"id": id, "version": version, "config": map[string]any{}})
		}
		return out
	}
	for _, e := range entries {
		out = append(out, map[string]any{"id": e.ID, "version": e.Version, "config": map[string]any{}})
	}
	return out
}
