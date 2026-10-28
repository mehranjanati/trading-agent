// Package skills — risk-based position sizing.
//
// PositionSize computes how many contracts to trade given account equity,
// risk-per-trade percent, stop-loss distance, and symbol price. Output is
// advisory only — it never places an order. Callers (dashboard / Worker)
// decide whether to apply the recommendation.
//
// Payload fields:
//   equity        — account equity in quote currency (required, >0)
//   risk_pct      — fraction of equity to risk (default 0.01 = 1%%)
//   stop_loss_px  — stop price in quote currency (required for percent-based)
//   entry_px      — entry price (defaults to current symbol px)
//   leverage      — max leverage allowed (default 1, capped at 10)
//   symbol_price  — current mark price (fallback for entry)
//
// Result Data:
//   qty           — contracts to trade (base asset)
//   notional      — qty * entry_px in quote currency
//   risk_amount   — equity * risk_pct (quote currency at risk)
//   stop_distance — |entry - stop| / entry
//   leverage_used — effective leverage
package skills

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"time"
)

// PositionSize implements Skill.
type PositionSize struct{}

// Name returns the skill name.
func (p PositionSize) Name() string { return "position-size" }

// sizeConfig holds parsed payload fields.
type sizeConfig struct {
	Equity       float64 `json:"equity"`
	RiskPct      float64 `json:"risk_pct"`
	StopLossPx   string  `json:"stop_loss_px"`
	EntryPx      string  `json:"entry_px"`
	SymbolPrice  string  `json:"symbol_price"`
	LeverageMax  int     `json:"leverage_max"`
}

// defaultSizeConfig returns sane defaults.
func defaultSizeConfig() sizeConfig {
	return sizeConfig{
		RiskPct:    0.01, // 1%%
		LeverageMax: 1,
	}
}

// sizeResult is the Data payload for position-size.
type sizeResult struct {
	Qty           float64 `json:"qty"`           // contracts (base asset)
	Notional      float64 `json:"notional"`      // quote currency
	RiskAmount    float64 `json:"risk_amount"`   // quote currency at risk
	StopDistance  float64 `json:"stop_distance"` // |entry-stop| / entry
	LeverageUsed  int     `json:"leverage_used"`
	EntryPx       float64 `json:"entry_px"`
	StopLossPx    float64 `json:"stop_loss_px"`
	RiskPctUsed   float64 `json:"risk_pct_used"`
	Reason        string  `json:"reason"`
}

// Run computes the position size.
func (p PositionSize) Run(ctx context.Context, req Request) (Result, error) {
	at := req.AsOfTS
	if at == "" {
		at = time.Now().UTC().Format(time.RFC3339)
	}
	cfg := defaultSizeConfig()
	if req.Payload != nil {
		_ = json.Unmarshal(req.Payload, &cfg)
	}

	entry, err := resolveEntry(cfg, req.Symbol)
	if err != nil {
		return failResult(p.Name(), req.Symbol, at, "INVALID_ENTRY", err.Error()), nil
	}

	stop, hasStop := parsePositive(cfg.StopLossPx)
	riskPct := cfg.RiskPct
	if riskPct <= 0 || riskPct > 0.5 {
		riskPct = 0.01
	}

	riskAmount := cfg.Equity * riskPct

	result := sizeResult{
		EntryPx:    entry,
		RiskPctUsed: riskPct,
	}

	if !hasStop || stop <= 0 {
		// No stop: size by notional cap only (conservative: 1 contract per X equity).
		// Fall back to risk_amount / entry as notional guidance.
		result.Qty = riskAmount / entry
		result.Notional = result.Qty * entry
		result.RiskAmount = result.Notional * 0.02 // assume 2%% adverse move
		result.StopDistance = 0.02
		result.LeverageUsed = 1
		result.Reason = "no stop loss provided; sized conservatively by notional"
	} else {
		dist := math.Abs(entry-stop) / entry
		if dist == 0 {
			return failResult(p.Name(), req.Symbol, at, "ZERO_STOP_DISTANCE", "stop equals entry"), nil
		}
		result.StopDistance = dist
		// qty = risk_amount / (entry * dist)
		qty := riskAmount / (entry * dist)
		// Cap by leverage: notional <= equity * leverage_max
		maxNotional := cfg.Equity * float64(cfg.LeverageMax)
		if maxNotional <= 0 {
			maxNotional = cfg.Equity
		}
		maxQty := maxNotional / entry
		if qty > maxQty {
			qty = maxQty
			result.Reason = fmt.Sprintf("capped by leverage %dx", cfg.LeverageMax)
		} else {
			result.Reason = "risk-based size"
		}
		result.Qty = qty
		result.Notional = qty * entry
		result.RiskAmount = riskAmount
		result.LeverageUsed = int(math.Ceil(result.Notional / cfg.Equity))
		if result.LeverageUsed < 1 {
			result.LeverageUsed = 1
		}
		if result.LeverageUsed > cfg.LeverageMax {
			result.LeverageUsed = cfg.LeverageMax
		}
	}

	if result.Qty <= 0 {
		return failResult(p.Name(), req.Symbol, at, "ZERO_QTY", "computed quantity is zero"), nil
	}

	data, _ := json.Marshal(result)
	var dataMap map[string]any
	_ = json.Unmarshal(data, &dataMap)

	return Result{
		Skill:      p.Name(),
		Symbol:     req.Symbol,
		OK:         true,
		Data:       dataMap,
		Confidence: 0.85,
		Veto:       false,
		At:         at,
	}, nil
}

// resolveEntry picks the entry price: entry_px > symbol_price > 0.
func resolveEntry(cfg sizeConfig, symbol string) (float64, error) {
	if v, err := strconv.ParseFloat(cfg.EntryPx, 64); err == nil && v > 0 {
		return v, nil
	}
	if v, err := strconv.ParseFloat(cfg.SymbolPrice, 64); err == nil && v > 0 {
		return v, nil
	}
	return 0, fmt.Errorf("no valid entry price for %s", symbol)
}

// parsePositive parses a decimal string to float64; returns false if absent/invalid.
func parsePositive(s string) (float64, bool) {
	if s == "" {
		return 0, false
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil || v <= 0 {
		return 0, false
	}
	return v, true
}
