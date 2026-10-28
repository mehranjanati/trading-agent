// Package skills — native trading-skill engine (Go plane).
//
// A skill is a pure, deterministic Go function that transforms a SkillRequest
// into a SkillResult. Unlike WASM strategies (E13), skills run directly inside
// go-watcher with full stdlib access: Redis, D1 snapshot via Workers, and
// local clock are available. Skills are advisory by construction — they never
// write D1, never place orders, and never gate /readyz.
//
// Layout:
//   skills/skills.go        — core types, Registry, Router
//   skills/market_regime.go — market-regime detection (trending / ranging / volatile)
//   skills/position_size.go — risk-based position sizing
//   skills/loader.go        — in-memory loader + HTTP facade hooks
//
// Each skill is registered once at startup; callers resolve by name via
// Router.Run(ctx, name, req).
package skills

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"sync"
)

// Request is the generic input every skill receives.
//
// Symbol is canonical (e.g. ETHUSDT). Payload carries skill-specific fields
// marshaled from the caller; each skill validates its own required keys.
type Request struct {
	Symbol   string          `json:"symbol"`
	Payload  json.RawMessage `json:"payload"`
	AsOfTS   string          `json:"asof_ts"`
	TraceID  string          `json:"trace_id"`
	Deadline int             `json:"deadline_ms"`
}

// Result is the generic output every skill produces.
//
// Regime/Size/etc. are skill-specific and marshaled into Data. Every result
// carries Confidence (0..1) and a Veto flag: when Veto=true the caller should
// treat the downstream decision as blocked until the condition clears.
type Result struct {
	Skill    string                 `json:"skill"`
	Symbol   string                 `json:"symbol"`
	OK       bool                   `json:"ok"`
	Data     map[string]any         `json:"data"`
	Confidence float64               `json:"confidence"`
	Veto     bool                   `json:"veto"`
	Diagnostics  *Diagnostics          `json:"diagnostics,omitempty"`
	At       string                 `json:"at"`
}

// Diagnostics reports non-fatal skill diagnostics (why a veto fired, missing
// inputs, fallback used).
type Diagnostics struct {
	Code  string `json:"code"`
	Reason string `json:"reason"`
	Logs  []string `json:"logs,omitempty"`
}

// Skill is the callable interface every skill implements.
type Skill interface {
	Name() string
	// Run applies the skill to req and returns a result. It must never panic;
	// on invalid input it returns OK=false with Diagnostics set.
	Run(ctx context.Context, req Request) (Result, error)
}

// Registry holds registered skills by name. Reload swaps the map wholesale so
// in-flight calls keep their old instances.
type Registry struct {
	mu sync.RWMutex
	by map[string]Skill
}

// NewRegistry builds an empty registry.
func NewRegistry() *Registry {
	return &Registry{by: map[string]Skill{}}
}

// Register adds or replaces a skill. Duplicate names overwrite (last wins).
func (r *Registry) Register(s Skill) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.by[s.Name()] = s
}

// Get returns a skill by name, or nil if absent.
func (r *Registry) Get(name string) (Skill, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	s, ok := r.by[name]
	return s, ok
}

// List returns registered skill names sorted alphabetically.
func (r *Registry) List() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]string, 0, len(r.by))
	for n := range r.by {
		out = append(out, n)
	}
	sort.Strings(out)
	return out
}

// Router resolves requests to registered skills.
type Router struct {
	reg *Registry
}

// NewRouter builds a router over reg.
func NewRouter(reg *Registry) *Router {
	return &Router{reg: reg}
}

// Run dispatches req to the named skill. If the skill is missing or returns an
// error, the result carries OK=false with Diagnostics populated.
func (rt *Router) Run(ctx context.Context, name string, req Request) (Result, error) {
	s, ok := rt.reg.Get(name)
	if !ok {
		return Result{
			Skill: name, Symbol: req.Symbol, OK: false,
			Diagnostics: &Diagnostics{Code: "SKILL_NOT_FOUND", Reason: "skill " + name + " is not registered"},
			At: req.AsOfTS,
		}, fmt.Errorf("skill %q not found", name)
	}
	return s.Run(ctx, req)
}

// writeResult is a small helper to produce a failure Result with diagnostics.
func failResult(name, symbol, at string, code, reason string, logs ...string) Result {
	return Result{
		Skill:      name,
		Symbol:     symbol,
		OK:         false,
		Data:       map[string]any{},
		Confidence: 0,
		Veto:       true,
		Diagnostics: &Diagnostics{
			Code:    code,
			Reason:  reason,
			Logs:    logs,
		},
		At: at,
	}
}
