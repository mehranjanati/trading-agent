// Package skills — market regime detection.
//
// MarketRegime inspects recent price action (candles or single tick) and classifies
// the market as trending_up, trending_down, ranging, or volatile. It is advisory:
// it never writes D1 and never blocks execution directly — callers use Veto to
// decide whether to suppress new entries.
//
// Indicators used (all stdlib, decimal-string safe):
//   - EMA slope over N closes (direction)
//   - ATR percentage (volatility band)
//   - Simple ADX-like spread between high/low and close (strength)
//
// Thresholds are configurable via payload: ema_period, atr_period, adx_period,
// range_pct (default 0.005 = 0.5%% band for "ranging"), vol_pct (default 0.02 = 2%% ATR).
package skills

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// MarketRegime implements Skill.
type MarketRegime struct{}

// Name returns the skill name.
func (m MarketRegime) Name() string { return "market-regime" }

// regimeConfig holds parsed payload fields for MarketRegime.
type regimeConfig struct {
	EMAPeriod  int     `json:"ema_period"`
	ATRPeriod  int     `json:"atr_period"`
	ADXPeriod  int     `json:"adx_period"`
	RangePct   float64 `json:"range_pct"`
	VolPct     float64 `json:"vol_pct"`
	Lookback   int     `json:"lookback"`
}

// defaultRegimeConfig returns sane defaults.
func defaultRegimeConfig() regimeConfig {
	return regimeConfig{
		EMAPeriod:  20,
		ATRPeriod:  14,
		ADXPeriod:  14,
		RangePct:   0.005, // 0.5%% band → "ranging" when price stays inside
		VolPct:     0.02,   // 2%% ATR → above this is "volatile"
		Lookback:   100,
	}
}

// regimeResult is the Data payload for market-regime.
type regimeResult struct {
	Regime     string  `json:"regime"`        // trending_up | trending_down | ranging | volatile | unknown
	Confidence float64 `json:"confidence"`    // 0..1
	Veto       bool    `json:"veto"`          // true when volatile or unreadable
	EMASlope   float64 `json:"ema_slope"`     // signed slope of EMA over period
	ATRPct     float64 `json:"atr_pct"`       // ATR as fraction of price
	Strength   float64 `json:"strength"`      // ADX-like 0..100
	BarsUsed   int     `json:"bars_used"`     // candles actually consumed
	LastPx     string  `json:"last_px"`
	LastTs     string  `json:"last_ts"`
	Reason     string  `json:"reason"`        // human-readable classification rationale
}

// Run classifies the market regime.
func (m MarketRegime) Run(ctx context.Context, req Request) (Result, error) {
	at := req.AsOfTS
	if at == "" {
		at = time.Now().UTC().Format(time.RFC3339)
	}
	cfg := defaultRegimeConfig()
	if err := json.Unmarshal(req.Payload, &cfg); err != nil {
		// Non-fatal: fall back to defaults.
	}

	// Parse candles if present in payload under "candles" key.
	var raw struct {
		Candles []CandleInput `json:"candles"`
		Px      string        `json:"px"`
		Ts      string        `json:"ts"`
	}
	if req.Payload != nil {
		_ = json.Unmarshal(req.Payload, &raw)
	}

	candles := normalizeCandleInputs(raw.Candles, cfg.Lookback)
	if len(candles) == 0 && raw.Px != "" {
		// Single-tick fallback: synthesize one bar from the tick.
		var tickTs int64
		if raw.Ts != "" {
			fmt.Sscanf(raw.Ts, "%d", &tickTs)
		}
		candles = []CandleInput{{Close: raw.Px, High: raw.Px, Low: raw.Px, Open: raw.Px, Ts: tickTs}}
	}

	res := regimeResult{LastPx: raw.Px, LastTs: raw.Ts}

	switch {
	case len(candles) < cfg.EMAPeriod+2:
		res.Regime = "unknown"
		res.Veto = true
		res.Reason = "insufficient history"
		res.Confidence = 0
		return Result{
			Skill: m.Name(), Symbol: req.Symbol, OK: true,
			Data: map[string]any{"regime": res.Regime, "confidence": res.Confidence, "veto": res.Veto, "reason": res.Reason, "bars_used": res.BarsUsed},
			Confidence: res.Confidence, Veto: res.Veto,
			Diagnostics: &Diagnostics{Code: "INSUFFICIENT_DATA", Reason: res.Reason}, At: at,
		}, nil

	case len(candles) < cfg.ATRPeriod+2:
		// Not enough for ATR, but enough for EMA slope → weak trend call.
		slope := emaSlope(candles, cfg.EMAPeriod)
		res.Regime, res.Confidence, res.Reason = weakTrend(slope)
		res.ATRPct = 0
		res.Strength = 0
		res.EMASlope = slope
		res.BarsUsed = len(candles)
	default:
		res = classify(candles, cfg)
		res.BarsUsed = len(candles)
	}

	// Veto when volatile (or unknown).
	if res.Regime == "volatile" || res.Regime == "unknown" {
		res.Veto = true
	}

	data, _ := json.Marshal(res)
	var dataMap map[string]any
	_ = json.Unmarshal(data, &dataMap)

	return Result{
		Skill:      m.Name(),
		Symbol:     req.Symbol,
		OK:         true,
		Data:       dataMap,
		Confidence: res.Confidence,
		Veto:       res.Veto,
		At:         at,
	}, nil
}
