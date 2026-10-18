// registry_retire_test.go — retirement (status: "retired", ADR-011).
//
// The rule this pins: a published artifact is immutable, so "removing" one means
// RETIRING it. A retired version must stay loaded and executable (an in-flight
// reference — an armed watch, an approval mid flight, a group/room that pins it —
// must never become invalid mid-trade) while being excluded from the set a NEW
// pin set may draw from (`Registry.Active`). There is no delete: the bytes and
// their sha256 stay on disk so every recorded run stays reproducible.
//
// A typo in the manifest must fail CLOSED at load, never be read as "active".
//
// No wazero runtime is needed: Open() only reads registry.json and hashes bytes.
package strategies

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// tempRegistry writes a registry dir with two rows — one active (status absent,
// proving the default) and one retired — both pointing at a real sample artifact.
func tempRegistry(t *testing.T, rows string) string {
	t.Helper()
	dir := t.TempDir()
	wasm, err := os.ReadFile(filepath.Join("samples", "sma-cross-0.1.0.wasm"))
	if err != nil {
		t.Fatalf("read sample wasm: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "sma-cross-0.1.0.wasm"), wasm, 0o644); err != nil {
		t.Fatalf("write wasm: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "registry.json"), []byte(rows), 0o644); err != nil {
		t.Fatalf("write registry.json: %v", err)
	}
	return dir
}

const retireRows = `[
  {"id":"sma-cross","version":"0.1.0","file":"sma-cross-0.1.0.wasm","name":"active one","configuration":{}},
  {"id":"sma-cross","version":"0.2.0","file":"sma-cross-0.1.0.wasm","name":"retired one","configuration":{},"status":"retired","retired_reason":"superseded by 0.3.0 — wider invalidation"}
]`

func TestRegistryStatusDefaultsToActive(t *testing.T) {
	reg, err := Open(tempRegistry(t, retireRows))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	e, ok := reg.Get("sma-cross", "0.1.0")
	if !ok {
		t.Fatal("active version missing")
	}
	if e.Status != StatusActive {
		t.Errorf("status = %q, want %q (an absent manifest field must default to active)", e.Status, StatusActive)
	}
	if e.Retired() {
		t.Error("an absent status must not read as retired")
	}
}

// The whole point: retired is NOT deleted. It keeps its bytes and sha256 (so an
// in-flight run and its recorded hash stay valid) and stays resolvable, but it
// leaves the selectable set.
func TestRetiredVersionStaysExecutableButNotSelectable(t *testing.T) {
	reg, err := Open(tempRegistry(t, retireRows))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	retired, ok := reg.Get("sma-cross", "0.2.0")
	if !ok {
		t.Fatal("retired version is NOT resolvable — an in-flight reference would break")
	}
	if !retired.Retired() || retired.Status != StatusRetired {
		t.Errorf("status = %q, want %q", retired.Status, StatusRetired)
	}
	if len(retired.WASM) == 0 || len(retired.SHA256) != 64 {
		t.Errorf("retired artifact lost its bytes/hash: len(wasm)=%d sha256=%q", len(retired.WASM), retired.SHA256)
	}
	if retired.RetiredReason == "" {
		t.Error("retired_reason was dropped — the UI cannot say why it is not offered")
	}

	// List (the catalog) still shows it; Active (new pin sets) does not.
	var listed, active bool
	for _, e := range reg.List() {
		if e.ID == "sma-cross" && e.Version == "0.2.0" {
			listed = true
		}
	}
	for _, e := range reg.Active() {
		if e.Version == "0.2.0" {
			active = true
		}
	}
	if !listed {
		t.Error("retired version missing from List — the catalog would silently lose it")
	}
	if active {
		t.Error("retired version offered by Active — a NEW pin set must never draw from it")
	}
	if got := len(reg.Active()); got != 1 {
		t.Errorf("Active() = %d entries, want 1 (the active one)", got)
	}
}

func TestRegistryRejectsUnknownStatus(t *testing.T) {
	bad := `[{"id":"x","version":"1.0.0","file":"sma-cross-0.1.0.wasm","configuration":{},"status":"deprecated"}]`
	_, err := Open(tempRegistry(t, bad))
	if err == nil {
		t.Fatal("an unknown status was accepted — it must fail closed, never read as active")
	}
	if want := "unknown status"; !contains(err.Error(), want) {
		t.Errorf("error = %q, want it to name %q", err.Error(), want)
	}
}

// The dashboard picker decides from the wire shape: status per entry plus the
// selectable count.
func TestRegistryEndpointServesStatusAndActiveCount(t *testing.T) {
	reg, err := Open(tempRegistry(t, retireRows))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	srv := httptest.NewServer(http.HandlerFunc(NewEngine(reg, nil, "").ServeRegistry))
	defer srv.Close()

	res, err := http.Get(srv.URL)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer res.Body.Close()
	var got RegistryResponse
	if err := json.NewDecoder(res.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Count != 2 || got.ActiveCount != 1 {
		t.Errorf("count/active_count = %d/%d, want 2/1", got.Count, got.ActiveCount)
	}
	byKey := map[string]RegistryEntry{}
	for _, e := range got.Strategies {
		byKey[e.Version] = e
		if e.Status == "" {
			t.Errorf("%s@%s has no status on the wire — the picker cannot filter it", e.ID, e.Version)
		}
	}
	if byKey["0.2.0"].Status != StatusRetired || byKey["0.2.0"].RetiredReason == "" {
		t.Errorf("retired entry on the wire = %+v", byKey["0.2.0"])
	}
	if byKey["0.1.0"].Status != StatusActive {
		t.Errorf("active entry status = %q, want %q", byKey["0.1.0"].Status, StatusActive)
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
