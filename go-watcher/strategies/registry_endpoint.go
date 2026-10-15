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
}

// RegistryResponse is the GET /strategies/registry envelope. `at` rides along
// so the dashboard can badge the catalog's freshness like every other widget.
type RegistryResponse struct {
	Strategies []RegistryEntry `json:"strategies"`
	Count      int             `json:"count"`
	At         string          `json:"at"`
}

// ServeRegistry answers GET /strategies/registry. The catalog is the pinned
// registry loaded at boot (`Registry.List`), so a version that appears here is
// one the runner can actually execute — never a planned or draft strategy.
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
	for _, en := range entries {
		out = append(out, RegistryEntry{
			ID: en.ID, Version: en.Version, File: en.File,
			Name: en.Name, Description: en.Description,
			SHA256: en.SHA256, Configuration: en.Configuration,
		})
	}
	writeJSON(w, http.StatusOK, RegistryResponse{
		Strategies: out, Count: len(out), At: time.Now().UTC().Format(time.RFC3339),
	})
}
