// Aggregate verdict + ATR zone suggestions. The aggregate is advisory only:
// it never approves, never submits — approvals stay human (E08-T02).
package strategies

import (
	"fmt"
	"math"
	"strconv"
	"time"
)

// aggregate rolls verdicts into one advisory verdict. Weight is confidence;
// ERROR runs count as errors and never as votes. Ties and all-FLAT stay
// FLAT — the aggregate refuses to invent conviction.
func aggregate(vs []StrategyVerdict, want string) AggregateVerdict {
	agg := AggregateVerdict{N: len(vs)}
	var longW, shortW float64
	for _, v := range vs {
		if v.Result.Status == "ERROR" {
			agg.Errors++
			continue
		}
		switch v.Result.Decision.Bias {
		case "LONG":
			agg.Agree += agreeAs(v.Result.Decision.Bias, want)
			agg.Disagree += 1 - agreeAs(v.Result.Decision.Bias, want)
			longW += v.Result.Decision.Confidence
		case "SHORT":
			agg.Agree += agreeAs(v.Result.Decision.Bias, want)
			agg.Disagree += 1 - agreeAs(v.Result.Decision.Bias, want)
			shortW += v.Result.Decision.Confidence
		default:
			agg.Flat++
		}
	}
	denom := float64(agg.N - agg.Errors)
	switch {
	case longW > shortW && longW > 0:
		agg.Bias, agg.Confidence = "LONG", round2(longW/denom)
	case shortW > longW && shortW > 0:
		agg.Bias, agg.Confidence = "SHORT", round2(shortW/denom)
	default:
		agg.Bias, agg.Confidence = "FLAT", 0
	}
	agg.Explanation = fmt.Sprintf("%d verdicts (%d errors): longW=%.2f shortW=%.2f flat=%d", agg.N, agg.Errors, longW, shortW, agg.Flat)
	return agg
}

func agreeAs(bias, want string) int {
	if want == "" {
		return 0
	}
	if bias == want {
		return 1
	}
	return 0
}

func round2(f float64) float64 {
	return math.Round(f*100) / 100
}

// suggestZones derives ATR-based trigger/invalidation candidates from the
// first timeframe's closes. Decimal-exact strings; failures yield empties. The
// provider that answered, the bar count and the newest close/bar time are
// stamped onto the result: the zones are only as live as the bars they were
// measured on, and for a symbol the primary venue does not list the fallback
// provider is the whole story.
func suggestZones(symbol, tf string) SuggestedZones {
	z := SuggestedZones{Timeframe: tf}
	bars, src, err := FetchKlines(symbol, tf)
	if err != nil || len(bars) < 15 {
		return z
	}
	atr := atrOf(bars, 14)
	newest := bars[len(bars)-1]
	last, err := parseF(newest.Close)
	if err != nil || atr <= 0 || last <= 0 {
		return z
	}
	z.Source = src
	z.Bars = len(bars)
	z.Last = newest.Close
	z.LastTS = time.UnixMilli(newest.Ts).UTC().Format(time.RFC3339)
	z.ATR = fmtNum(atr)
	z.TriggerLong = fmtNum(last + 0.25*atr)
	z.InvalLong = fmtNum(last - 1.0*atr)
	z.TriggerShort = fmtNum(last - 0.25*atr)
	z.InvalShort = fmtNum(last + 1.0*atr)
	return z
}

func atrOf(bars []CandleWire, n int) float64 {
	if len(bars) < n+1 {
		return 0
	}
	sum := 0.0
	tail := bars[len(bars)-n-1:]
	for i := 1; i < len(tail); i++ {
		h, e1 := parseF(tail[i].High)
		l, e2 := parseF(tail[i].Low)
		c, e3 := parseF(tail[i-1].Close)
		if e1 != nil || e2 != nil || e3 != nil {
			return 0
		}
		hi, lo := h, l
		if c > hi {
			hi = c
		}
		if c < lo {
			lo = c
		}
		sum += hi - lo
	}
	return sum / float64(n)
}

func parseF(s string) (float64, error) {
	return strconv.ParseFloat(s, 64)
}

func fmtNum(f float64) string {
	return strconv.FormatFloat(f, 'f', -1, 64)
}
