// ServeRegistry implements GET /strategies/registry: the pinned-WASM catalog
// the dashboard renders (docs/17 §17.2).
//
// ADVISORY read-only. Like /analyze it costs no approval, writes no order and
// never touches D1 — it exists so the library tab lists the REAL pinned
// artifacts (id@version, sha256, configuration) instead of a copy hardcoded in
// the UI that silently drifts from registry.json.
//
// CORS mirrors ServeAnalyze: the Cloudflare Pages dashboard calls this origin
// directly (there is no Worker proxy to the Go plane).
package strategies

import (
	"net/http"
	"time"
)

// RegistryEntry is one pinned strategy version as served to clients. Entry's
// SHA256 is `json:"-"` (internal to the runner), so the wire shape is explicit
// here rather than implied by Entry.
type RegistryEntry struct {
	ID            string         `json:"id"`
	Version       string         `json:"version"`
	File          string         `json:"file"`
	Name          string         `json:"name,omitempty"`
	Description   string         `json:"description,omitempty"`
	SHA256        string         `json:"sha256"`
	Configuration map[string]any `json:"configuration"`
	// Status is "active" or "retired" (ADR-011). A retired version is STILL
	// executable — it is only non-selectable for NEW work — so it is served with
	// its status instead of being hidden: a group or room may still pin it and
	// the UI must be able to say why it is not offered in the pickers.
	Status        string `json:"status"`
	RetiredReason string `json:"retired_reason,omitempty"`
}

// RegistryResponse is the GET /strategies/registry envelope. `at` rides along
// so the dashboard can badge the catalog's freshness like every other widget.
// Count is the FULL catalog (active + retired); ActiveCount is the selectable
// subset, which is what a new pin set may draw from.
type RegistryResponse struct {
	Strategies  []RegistryEntry `json:"strategies"`
	Count       int             `json:"count"`
	ActiveCount int             `json:"active_count"`
	At          string          `json:"at"`
}

// ServeRegistry answers GET /strategies/registry. The catalog is the pinned
// registry loaded at boot (`Registry.List`, which includes retired versions), so
// a version that appears here is one the runner can actually execute — never a
// planned or draft strategy. Each entry carries its lifecycle status; callers
// that build a NEW pin set must use the active ones (`active_count`).
func (e *Engine) ServeRegistry(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "content-type")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	entries := e.reg.List()
	out := make([]RegistryEntry, 0, len(entries))
	active := 0
	for _, en := range entries {
		if !en.Retired() {
			active++
		}
		out = append(out, RegistryEntry{
			ID: en.ID, Version: en.Version, File: en.File,
			Name: en.Name, Description: en.Description,
			SHA256: en.SHA256, Configuration: en.Configuration,
			Status: en.Status, RetiredReason: en.RetiredReason,
		})
	}
	writeJSON(w, http.StatusOK, RegistryResponse{
		Strategies: out, Count: len(out), ActiveCount: active,
		At: time.Now().UTC().Format(time.RFC3339),
	})
}
