// Strategy registry: versioned WASM artifacts on disk + hot reload.
//
// Layout (STRATEGIES_DIR, default ./strategies/samples):
//   registry.json                       — [{id, version, file, name?, description?, configuration}]
//   <id>-<version>.wasm                 — wasip1 command modules
// Versions are immutable: a file that changes under a loaded version is only
// picked up by :reload (fail-closed reads keep serving the pinned bytes).
package strategies

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
)

// Entry is one pinned strategy version.
type Entry struct {
	ID            string         `json:"id"`
	Version       string         `json:"version"`
	File          string         `json:"file"`
	Name          string         `json:"name,omitempty"`
	Description   string         `json:"description,omitempty"`
	Configuration map[string]any `json:"configuration"`
	WASM          []byte         `json:"-"`
	SHA256        string         `json:"-"`
}

// manifestRow is the on-disk registry.json row. Name/Description are optional
// catalog labels: the dashboard renders them verbatim so the pinned list has
// exactly ONE source (this file), never a hardcoded copy in the UI.
type manifestRow struct {
	ID            string         `json:"id"`
	Version       string         `json:"version"`
	File          string         `json:"file"`
	Name          string         `json:"name"`
	Description   string         `json:"description"`
	Configuration map[string]any `json:"configuration"`
}

// Registry loads pinned WASM bytes. Reads are lock-guarded; :reload swaps
// the map wholesale so in-flight runs keep their old bytes.
type Registry struct {
	dir string
	mu  sync.RWMutex
	by  map[string]Entry // key id + "@" + version
}

// Open loads the registry once; use Reload after dropping new artifacts.
func Open(dir string) (*Registry, error) {
	r := &Registry{dir: dir, by: map[string]Entry{}}
	if err := r.Reload(); err != nil {
		return nil, err
	}
	return r, nil
}

// Reload re-reads registry.json + artifacts wholesale.
func (r *Registry) Reload() error {
	raw, err := os.ReadFile(filepath.Join(r.dir, "registry.json"))
	if err != nil {
		return fmt.Errorf("strategies: registry: %w", err)
	}
	var rows []manifestRow
	if err := json.Unmarshal(raw, &rows); err != nil {
		return fmt.Errorf("strategies: registry manifest: %w", err)
	}
	by := make(map[string]Entry, len(rows))
	for _, row := range rows {
		if row.ID == "" || row.Version == "" || row.File == "" {
			return fmt.Errorf("strategies: registry: row missing id/version/file")
		}
		path := filepath.Join(r.dir, filepath.Clean("/"+row.File))
		wasm, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("strategies: registry %s@%s: %w", row.ID, row.Version, err)
		}
		if len(wasm) == 0 || len(wasm) > 16*1024*1024 {
			return fmt.Errorf("strategies: registry %s@%s: bad artifact size %d", row.ID, row.Version, len(wasm))
		}
		sum := sha256.Sum256(wasm)
		cfg := row.Configuration
		if cfg == nil {
			cfg = map[string]any{}
		}
		by[row.ID+"@"+row.Version] = Entry{
			ID: row.ID, Version: row.Version, File: row.File,
			Name: row.Name, Description: row.Description,
			Configuration: cfg, WASM: wasm, SHA256: hex.EncodeToString(sum[:]),
		}
	}
	r.mu.Lock()
	r.by = by
	r.mu.Unlock()
	return nil
}

// Get returns pinned bytes for id@version ("latest" resolves the highest
// version by semver-ish string order — registry.json should pin callers, not
// this helper).
func (r *Registry) Get(id, version string) (Entry, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if version == "" || version == "latest" {
		var best Entry
		found := false
		for k, e := range r.by {
			if len(k) > len(id)+1 && k[:len(id)+1] == id+"@" {
				if !found || e.Version > best.Version {
					best, found = e, true
				}
			}
		}
		return best, found
	}
	e, ok := r.by[id+"@"+version]
	return e, ok
}

// List returns the pinned catalog sorted by id, then version.
func (r *Registry) List() []Entry {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Entry, 0, len(r.by))
	for _, e := range r.by {
		c := e
		c.WASM = nil
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].ID != out[j].ID {
			return out[i].ID < out[j].ID
		}
		return out[i].Version < out[j].Version
	})
	return out
}
