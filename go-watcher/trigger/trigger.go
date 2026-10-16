// Package trigger — E03-T01-S1: deterministic trigger/invalidation evaluation.
// Pure logic, no I/O: given a normalized tick + ACTIVE watch definitions,
// decide match/no-match deterministically (replay-safe for golden fixtures).
// Trigger JSON shape (per docs/05): {"op":">="|"<="|"cross_above"|"cross_below","price":"...","confirm_ticks":N}
package trigger

import (
	"encoding/json"
	"fmt"
	"strconv"
)

// Definition is one ACTIVE watch's trigger + invalidation.
type Definition struct {
	ID          string
	Symbol      string // canonical, e.g. BTCUSDT
	TriggerJSON string
	InvalJSON   string
	TriggerSeq  int // increments per fire; part of dedupe_key
	// Version is the D1 optimistic-concurrency version the definition was read
	// at (snapshot). The Worker refuses a fire whose version no longer matches,
	// so a stale evaluation can never move a watch that already left ACTIVE.
	Version int
}

type cond struct {
	Op           string `json:"op"`
	Price        string `json:"price"`
	ConfirmTicks int    `json:"confirm_ticks"`
}

func parseCond(raw string) (cond, error) {
	var c cond
	if err := json.Unmarshal([]byte(raw), &c); err != nil {
		return c, fmt.Errorf("trigger: bad cond: %w", err)
	}
	switch c.Op {
	case ">=", "<=", "cross_above", "cross_below":
	default:
		return c, fmt.Errorf("trigger: unknown op %q", c.Op)
	}
	if _, err := strconv.ParseFloat(c.Price, 64); err != nil {
		return c, fmt.Errorf("trigger: bad price: %w", err)
	}
	return c, nil
}

// Eval reports whether px satisfies the trigger condition given prevPx.
// cross_* needs the previous tick; >= / <= are level checks.
func Eval(triggerJSON, px, prevPx string) (bool, error) {
	c, err := parseCond(triggerJSON)
	if err != nil {
		return false, err
	}
	cur, _ := strconv.ParseFloat(px, 64)
	lvl, _ := strconv.ParseFloat(c.Price, 64)
	switch c.Op {
	case ">=":
		return cur >= lvl, nil
	case "<=":
		return cur <= lvl, nil
	case "cross_above":
		prev, err := strconv.ParseFloat(prevPx, 64)
		if err != nil {
			return false, fmt.Errorf("trigger: cross needs prevPx")
		}
		return prev < lvl && cur >= lvl, nil
	case "cross_below":
		prev, err := strconv.ParseFloat(prevPx, 64)
		if err != nil {
			return false, fmt.Errorf("trigger: cross needs prevPx")
		}
		return prev > lvl && cur <= lvl, nil
	}
	return false, nil
}

// Validate reports whether a trigger/invalidation JSON is evaluable at all
// (known op, decimal price). The loop drops a definition that fails this instead
// of discovering the fault on every tick — one place decides what is evaluable.
func Validate(condJSON string) error {
	_, err := parseCond(condJSON)
	return err
}

// Invalidated reports whether the invalidation condition hit (watch → INVALIDATED).
func Invalidated(invalJSON, px string) (bool, error) {
	if invalJSON == "" || invalJSON == "{}" {
		return false, nil
	}
	return Eval(invalJSON, px, "")
}
