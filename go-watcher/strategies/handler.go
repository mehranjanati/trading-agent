// ServeAnalyze + runTF: POST /analyze handler and per-timeframe runs.
package strategies

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// ServeAnalyze implements POST /analyze.
func (e *Engine) ServeAnalyze(w http.ResponseWriter, r *http.Request) {
	// CORS: dashboard (pages.dev / localhost:3000) calls this directly.
	// Analysis is advisory (no orders, no approvals) — D-08 preserved.
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "content-type")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req AnalyzeRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024))
	if err := dec.Decode(&req); err != nil {
		writeAnalyzeErr(w, http.StatusBadRequest, "VALIDATION", "bad JSON: "+err.Error())
		return
	}
	if req.Symbol == "" {
		writeAnalyzeErr(w, http.StatusBadRequest, "VALIDATION", "symbol required")
		return
	}
	tfs := req.Timeframes
	if len(tfs) == 0 {
		tfs = []string{"15m", "1h", "4h"}
	}
	for _, tf := range tfs {
		if !validTFs[tf] {
			writeAnalyzeErr(w, http.StatusBadRequest, "VALIDATION", "timeframe "+tf+" not 15m|1h|4h")
			return
		}
	}
	if len(tfs) > 3 {
		writeAnalyzeErr(w, http.StatusBadRequest, "VALIDATION", "at most 3 timeframes")
		return
	}
	if len(req.Strategies) == 0 || len(req.Strategies) > 8 {
		writeAnalyzeErr(w, http.StatusBadRequest, "VALIDATION", "1..8 strategies required")
		return
	}
	if req.Direction != "" && req.Direction != "LONG" && req.Direction != "SHORT" {
		writeAnalyzeErr(w, http.StatusBadRequest, "VALIDATION", "direction must be LONG|SHORT")
		return
	}

	now := time.Now().UTC()
	id := fmt.Sprintf("an_%s_%d", now.Format("20060102T150405"), analyzeSeq.Add(1))
	resp := AnalyzeResponse{
		ID: id, Symbol: req.Symbol, At: now.Format(time.RFC3339),
		Verdicts: []StrategyVerdict{},
	}
	for _, tf := range tfs {
		bars, src, err := FetchKlines(req.Symbol, tf)
		if err != nil {
			writeAnalyzeErr(w, http.StatusBadGateway, "DATA_UNAVAILABLE", err.Error())
			return
		}
		e.runTF(r.Context(), &resp, req, tf, bars, src, now)
	}
	resp.Aggregate = aggregate(resp.Verdicts, req.Direction)
	resp.SuggestZones = suggestZones(req.Symbol, tfs[0])
	writeJSON(w, http.StatusOK, resp)
}

// runTF executes every requested strategy on one timeframe's bars.
func (e *Engine) runTF(ctx context.Context, resp *AnalyzeResponse, req AnalyzeRequest, tf string, bars []CandleWire, src string, now time.Time) {
	candles := make([]Candle, 0, len(bars))
	for _, b := range bars {
		candles = append(candles, b.ToContract())
	}
	last := bars[len(bars)-1]
	for _, s := range req.Strategies {
		entry, ok := e.reg.Get(s.ID, s.Version)
		if !ok {
			resp.Verdicts = append(resp.Verdicts, StrategyVerdict{
				StrategyID: s.ID, StrategyVersion: s.Version, Timeframe: tf,
				InvocationID: "inv_unknown",
				Result:       errorResult(Invocation{StrategyID: s.ID}, "VALIDATION", "unknown strategy "+s.ID+"@"+s.Version),
			})
			continue
		}
		cfg := mergeConfig(entry.Configuration, s.Config)
		invID := fmt.Sprintf("inv_%s_%s_%d", sanitize(s.ID), tf, len(resp.Verdicts))
		inv := Invocation{
			ContractVersion: "1", StrategyID: entry.ID, StrategyVersion: entry.Version,
			InvocationID: invID,
			MarketSnapshot: MarketSnapshot{
				Symbol: req.Symbol, Px: last.Close, Ts: now.Format(time.RFC3339),
				Src: src, Candles: candles,
			},
			StrategyConfiguration: cfg,
			PreviousState:         map[string]any{},
			ExecutionContext: ExecutionContext{
				AsOfTS: now.Format(time.RFC3339), DeadlineMs: 500,
				TraceID: resp.ID,
			},
		}
		h := sha256.Sum256(mustJSON(inv))
		res := e.runner.Run(ctx, entry.WASM, inv)
		resp.Verdicts = append(resp.Verdicts, StrategyVerdict{
			StrategyID: entry.ID, StrategyVersion: entry.Version,
			StrategySHA256: entry.SHA256, Timeframe: tf,
			InvocationID: invID, InputHash: hex.EncodeToString(h[:]),
			Result: res, DataSource: src,
		})
	}
}
