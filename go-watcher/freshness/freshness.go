// Package freshness — E03-T02-S1: per-symbol staleness detector.
// Default thresholds (Q-04 proposal): majors 5s, alts 10s.
// Stale trigger evaluation is forbidden: caller must emit HELD_STALE (S2 path records it).
package freshness

import "strings"

// Thresholds maps canonical symbol → stale-after duration in ms.
type Thresholds struct {
	MajorMs int64 // default 5000
	AltMs   int64 // default 10000
}

// Default returns the Q-04 proposal thresholds.
func Default() Thresholds { return Thresholds{MajorMs: 5000, AltMs: 10000} }

var majors = map[string]bool{"BTCUSDT": true, "ETHUSDT": true, "SOLUSDT": true}

// LimitMs returns the staleness limit for a symbol.
func (t Thresholds) LimitMs(symbol string) int64 {
	if majors[strings.ToUpper(symbol)] {
		return t.MajorMs
	}
	return t.AltMs
}

// Stale reports whether (nowMs - tickMs) exceeds the symbol limit.
// Future ticks (clock skew) are treated as fresh but flagged via skew=true.
func (t Thresholds) Stale(symbol string, tickMs, nowMs int64) (stale bool, skew bool) {
	age := nowMs - tickMs
	if age < 0 {
		return false, true
	}
	return age > t.LimitMs(symbol), false
}
