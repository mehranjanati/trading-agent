// Package triggerloop — the missing glue between the live tick feed and D1:
// last-px map + ACTIVE-set evaluation + a deterministic Fire per watch edge.
//
// WHY IT EXISTS (docs/02 §2.4 steps 1-3): the trigger engine (package trigger)
// and the tick normalizer (package normalize) were both complete and tested, but
// nothing ever fed one to the other, so an ACTIVE watch was never evaluated — a
// stalked zone armed and then did nothing. This package is the evaluation loop;
// the transport (ticks in, fire out) lives in tickfeed and main.
//
// Determinism: no clock and no I/O here. A tick carries its own timestamps, the
// caller passes ticks in order, and the same tick sequence always produces the
// same fires (the property cmd/replay proves for the fixtures).
//
// Semantics (docs/05 §5.3 guards):
//   - only ACTIVE definitions are held: `Set` replaces the whole set, and a watch
//     that fired is dropped locally until the next D1 reload re-adds it (so one
//     watch cannot fire twice while it is no longer ACTIVE).
//   - invalidation is checked BEFORE the trigger: a watch whose invalidation hit
//     is INVALIDATED, never TRIGGERED.
//   - `confirm_ticks` (from the trigger JSON) requires N consecutive confirming
//     ticks; a non-confirming tick resets the count. Absent/1 = fire immediately.
//   - a malformed definition or tick is skipped and counted, never fatal.
package triggerloop

import (
	"encoding/json"
	"time"

	"trading-agent/go-watcher/normalize"
	"trading-agent/go-watcher/trigger"
)

// Kind is the FSM edge a fire performs on the watch (docs/05 §5.3).
type Kind string

const (
	Triggered   Kind = "TRIGGERED"
	Invalidated Kind = "INVALIDATED"
)

// Fire is one watch edge the caller must persist (Worker route → D1 batch).
type Fire struct {
	WatchID      string
	Symbol       string
	Kind         Kind
	Px           string // the tick that decided it
	PrevPx       string // the previous tick for the same symbol ("" when unknown)
	Seq          int    // per-watch fire counter; part of the D1 dedupe_key
	WatchVersion int    // the version the evaluation was based on (optimistic concurrency)
	TriggerJSON  string
	At           time.Time // tick time (exchange ms), never a local clock read
}

// Engine evaluates ticks against the ACTIVE watch set.
type Engine struct {
	bySymbol map[string][]trigger.Definition
	last     map[string]string // symbol → previous price (for cross_*)
	confirm  map[string]int    // watchID → consecutive confirming ticks
	seq      map[string]int    // watchID → fires emitted
	skipped  int               // malformed definitions/ticks seen (metrics)
}

// New builds an empty engine.
func New() *Engine {
	return &Engine{
		bySymbol: map[string][]trigger.Definition{},
		last:     map[string]string{},
		confirm:  map[string]int{},
		seq:      map[string]int{},
	}
}

// Set replaces the ACTIVE set (one D1 snapshot reload). Definitions are grouped
// by canonical symbol; a definition with an unparsable trigger JSON is dropped
// and counted — it can never fire, and it must not stop the others.
func (e *Engine) Set(defs []trigger.Definition) {
	by := map[string][]trigger.Definition{}
	for _, d := range defs {
		if d.ID == "" || d.Symbol == "" {
			e.skipped++
			continue
		}
		if err := trigger.Validate(d.TriggerJSON); err != nil {
			e.skipped++
			continue
		}
		by[d.Symbol] = append(by[d.Symbol], d)
	}
	e.bySymbol = by
	// Drop confirm counters for watches that are no longer ACTIVE (a re-armed
	// watch starts its confirmation from scratch).
	live := map[string]bool{}
	for _, ds := range by {
		for _, d := range ds {
			live[d.ID] = true
		}
	}
	for id := range e.confirm {
		if !live[id] {
			delete(e.confirm, id)
		}
	}
}

// Symbols lists the canonical symbols the ACTIVE set needs ticks for.
func (e *Engine) Symbols() []string {
	out := make([]string, 0, len(e.bySymbol))
	for s := range e.bySymbol {
		out = append(out, s)
	}
	return out
}

// Skipped reports malformed definitions/ticks dropped so far (metrics).

// Apply folds one normalized tick into the state and returns the edges it
// decided (0..n fires — several watches can share a symbol).
func (e *Engine) Apply(t normalize.Tick) []Fire {
	if t.Symbol == "" || t.Price == "" {
		e.skipped++
		return nil
	}
	prev := e.last[t.Symbol]
	e.last[t.Symbol] = t.Price

	defs := e.bySymbol[t.Symbol]
	if len(defs) == 0 {
		return nil
	}
	at := time.UnixMilli(t.Ts).UTC()
	var fires []Fire
	for _, d := range defs {
		// Invalidation wins: a zone that broke is INVALIDATED, never TRIGGERED.
		if inv, err := trigger.Invalidated(d.InvalJSON, t.Price); err == nil && inv {
			fires = append(fires, e.fire(d, Invalidated, t, prev, at))
			continue
		}
		hit, err := trigger.Eval(d.TriggerJSON, t.Price, prev)
		if err != nil {
			// A cross_* trigger on the very first tick has no prev: not a match,
			// not a fault — the next tick can decide it.
			e.skipped++
			continue
		}
		if !hit {
			e.confirm[d.ID] = 0
			continue
		}
		if need := confirmTicks(d.TriggerJSON); need > 1 {
			e.confirm[d.ID]++
			if e.confirm[d.ID] < need {
				continue
			}
		}
		fires = append(fires, e.fire(d, Triggered, t, prev, at))
	}
	// A fired watch leaves the ACTIVE set locally: it must not fire again until
	// D1 says it is ACTIVE once more (reload), which is what keeps the seq /
	// dedupe_key monotonic per watch.
	for _, f := range fires {
		e.drop(f.WatchID)
	}
	return fires
}

func (e *Engine) fire(d trigger.Definition, kind Kind, t normalize.Tick, prev string, at time.Time) Fire {
	e.seq[d.ID]++
	return Fire{
		WatchID: d.ID, Symbol: d.Symbol, Kind: kind,
		Px: t.Price, PrevPx: prev, Seq: e.seq[d.ID],
		WatchVersion: d.Version, TriggerJSON: d.TriggerJSON, At: at,
	}
}

// drop removes a watch from the local ACTIVE view (it just moved out of ACTIVE).
func (e *Engine) drop(id string) {
	for sym, ds := range e.bySymbol {
		kept := ds[:0]
		for _, d := range ds {
			if d.ID != id {
				kept = append(kept, d)
			}
		}
		if len(kept) == 0 {
			delete(e.bySymbol, sym)
		} else {
			e.bySymbol[sym] = kept
		}
	}
	delete(e.confirm, id)
}

// confirmTicks reads confirm_ticks (default 1 = fire on the first match).
func confirmTicks(triggerJSON string) int {
	var c struct {
		ConfirmTicks int `json:"confirm_ticks"`
	}
	if err := json.Unmarshal([]byte(triggerJSON), &c); err != nil || c.ConfirmTicks < 1 {
		return 1
	}
	return c.ConfirmTicks
}

func (e *Engine) Skipped() int { return e.skipped }
