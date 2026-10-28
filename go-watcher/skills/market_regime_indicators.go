// Package skills — market regime indicator math (continued from market_regime.go).
package skills

import (
	"fmt"
	"math"
	"sort"
	"strconv"
)

// CandleInput is one OHLCV bar from payload.
type CandleInput struct {
	Ts     int64  `json:"ts"`
	Open   string `json:"open"`
	High   string `json:"high"`
	Low    string `json:"low"`
	Close  string `json:"close"`
	Volume string `json:"volume"`
}

// normalizeCandleInputs sorts candles by ts ascending and caps lookback.
func normalizeCandleInputs(in []CandleInput, lookback int) []CandleInput {
	if len(in) == 0 {
		return nil
	}
	sort.Slice(in, func(i, j int) bool { return in[i].Ts < in[j].Ts })
	if lookback > 0 && len(in) > lookback {
		in = in[len(in)-lookback:]
	}
	out := make([]CandleInput, 0, len(in))
	for _, c := range in {
		if c.Close == "" {
			continue
		}
		out = append(out, c)
	}
	return out
}

// parseCloses extracts close prices as float64.
func parseCloses(candles []CandleInput) []float64 {
	out := make([]float64, 0, len(candles))
	for _, c := range candles {
		if v, err := strconv.ParseFloat(c.Close, 64); err == nil {
			out = append(out, v)
		}
	}
	return out
}

// parseHighs extracts high prices.
func parseHighs(candles []CandleInput) []float64 {
	out := make([]float64, 0, len(candles))
	for _, c := range candles {
		if v, err := strconv.ParseFloat(c.High, 64); err == nil {
			out = append(out, v)
		} else if v, err := strconv.ParseFloat(c.Close, 64); err == nil {
			out = append(out, v)
		}
	}
	return out
}

// parseLows extracts low prices.
func parseLows(candles []CandleInput) []float64 {
	out := make([]float64, 0, len(candles))
	for _, c := range candles {
		if v, err := strconv.ParseFloat(c.Low, 64); err == nil {
			out = append(out, v)
		} else if v, err := strconv.ParseFloat(c.Close, 64); err == nil {
			out = append(out, v)
		}
	}
	return out
}

// classify runs the full regime detection.
func classify(candles []CandleInput, cfg regimeConfig) regimeResult {
	closes := parseCloses(candles)
	highs := parseHighs(candles)
	lows := parseLows(candles)

	slope := emaSlope(candles, cfg.EMAPeriod)
	atrPct := atrPct(highs, lows, closes, cfg.ATRPeriod)
	strength := adxLike(highs, lows, closes, cfg.ADXPeriod)

	last := closes[len(closes)-1]
	first := closes[0]
	totalRet := (last - first) / first

	r := regimeResult{
		EMASlope: slope,
		ATRPct:   atrPct,
		Strength: strength,
		LastPx:   fmt.Sprintf("%.8f", last),
	}

	if atrPct > cfg.VolPct {
		r.Regime = "volatile"
		r.Confidence = math.Min(0.5+atrPct/cfg.VolPct, 0.95)
		r.Reason = fmt.Sprintf("ATR %.2f%% > volatility threshold %.2f%%", atrPct*100, cfg.VolPct*100)
		return r
	}

	band := math.Abs(totalRet)
	if band < cfg.RangePct && math.Abs(slope) < 1e-6 {
		r.Regime = "ranging"
		r.Confidence = math.Min(0.6+strength/1000, 0.9)
		r.Reason = fmt.Sprintf("total return %.2f%% within range band %.2f%%, EMA flat", band*100, cfg.RangePct*100)
		return r
	}

	if slope > 0 {
		r.Regime = "trending_up"
		r.Confidence = math.Min(0.55+math.Abs(slope)*10+strength/200, 0.95)
		r.Reason = fmt.Sprintf("EMA slope +%.6f, strength %.0f", slope, strength)
	} else if slope < 0 {
		r.Regime = "trending_down"
		r.Confidence = math.Min(0.55+math.Abs(slope)*10+strength/200, 0.95)
		r.Reason = fmt.Sprintf("EMA slope %-.6f, strength %.0f", slope, strength)
	} else {
		r.Regime = "ranging"
		r.Confidence = 0.5
		r.Reason = "EMA flat, ATR moderate"
	}
	return r
}

// weakTrend is used when ATR cannot be computed.
func weakTrend(slope float64) (string, float64, string) {
	if slope > 0 {
		return "trending_up", 0.45, "EMA slope positive, insufficient ATR history"
	}
	if slope < 0 {
		return "trending_down", 0.45, "EMA slope negative, insufficient ATR history"
	}
	return "ranging", 0.4, "EMA flat, insufficient ATR history"
}

// emaSlope returns the signed slope of EMA over period using the last close.
func emaSlope(candles []CandleInput, period int) float64 {
	closes := parseCloses(candles)
	if len(closes) < period+1 {
		return 0
	}
	alpha := 2.0 / (float64(period) + 1)
	ema := closes[0]
	for i := 1; i < len(closes); i++ {
		ema = alpha*closes[i] + (1-alpha)*ema
	}
	prevEMA := closes[0]
	alpha2 := 2.0 / (float64(period) + 1)
	for i := 1; i < len(closes)-1; i++ {
		prevEMA = alpha2*closes[i] + (1-alpha2)*prevEMA
	}
	return ema - prevEMA
}

// atrPct computes ATR as fraction of last close.
func atrPct(highs, lows, closes []float64, period int) float64 {
	if len(closes) < period+1 {
		return 0
	}
	trs := make([]float64, 0, len(closes)-1)
	for i := 1; i < len(closes); i++ {
		hl := highs[i] - lows[i]
		hc := math.Abs(highs[i] - closes[i-1])
		lc := math.Abs(lows[i] - closes[i-1])
		tr := math.Max(hl, math.Max(hc, lc))
		trs = append(trs, tr)
	}
	if len(trs) < period {
		return 0
	}
	atr := 0.0
	for i := 0; i < period; i++ {
		atr += trs[i]
	}
	atr /= float64(period)
	for i := period; i < len(trs); i++ {
		atr = (atr*(float64(period)-1) + trs[i]) / float64(period)
	}
	lastClose := closes[len(closes)-1]
	if lastClose == 0 {
		return 0
	}
	return atr / lastClose
}

// adxLike returns a crude 0..100 strength measure from directional movement.
func adxLike(highs, lows, closes []float64, period int) float64 {
	if len(closes) < period+2 {
		return 0
	}
	var plusDM, minusDM, trSum float64
	for i := 1; i < len(closes) && i <= period; i++ {
		upMove := highs[i] - highs[i-1]
		downMove := lows[i-1] - lows[i]
		if upMove > downMove && upMove > 0 {
			plusDM += upMove
		}
		if downMove > upMove && downMove > 0 {
			minusDM += downMove
		}
		hl := highs[i] - lows[i]
		hc := math.Abs(highs[i] - closes[i-1])
		lc := math.Abs(lows[i] - closes[i-1])
		trSum += math.Max(hl, math.Max(hc, lc))
	}
	if trSum == 0 {
		return 0
	}
	diPlus := 100 * plusDM / trSum
	diMinus := 100 * minusDM / trSum
	denom := diPlus + diMinus
	if denom == 0 {
		return 0
	}
	dx := 100 * math.Abs(diPlus-diMinus) / denom
	return dx
}

