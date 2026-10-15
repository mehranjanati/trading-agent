// registry_endpoint_test.go — GET /strategies/registry serves the pinned
// catalog the dashboard library tab renders.
//
// The acceptance frame: (1) every entry the registry loaded appears with
// id/version/file/sha256/configuration — the sha256 is the REAL artifact hash,
// so the UI can show what it will execute; (2) name/description ride along from
// registry.json, which is the only place the catalog labels live; (3) the
// endpoint is a read-only GET (405 otherwise) with the CORS surface the Pages
// dashboard needs; (4) it touches no D1, no approval, no order — D-08 holds.
//
// No Go toolchain is required: Open() only reads registry.json, hashes the
// .wasm files and stores bytes.
package strategies

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// registryServer starts the endpoint on the checked-in samples registry.
func registryServer(t *testing.T) (*httptest.Server, *Registry) {
	t.Helper()
	reg, err := Open("samples")
	if err != nil {
		t.Fatalf("open samples registry: %v", err)
	}
	if len(reg.List()) == 0 {
		t.Fatal("samples registry is empty — the endpoint test would prove nothing")
	}
	// The runner is unused by the read-only catalog route; nil keeps the test
	// free of a wazero runtime.
	srv := httptest.NewServer(http.HandlerFunc(NewEngine(reg, nil, "").ServeRegistry))
	t.Cleanup(srv.Close)
	return srv, reg
}

func TestRegistryEndpointServesPinnedCatalog(t *testing.T) {
	srv, reg := registryServer(t)

	res, err := http.Get(srv.URL)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	var got RegistryResponse
	if err := json.NewDecoder(res.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}

	pinned := reg.List()
	if got.Count != len(pinned) || len(got.Strategies) != len(pinned) {
		t.Fatalf("count = %d/%d, want %d", got.Count, len(got.Strategies), len(pinned))
	}
	if got.At == "" {
		t.Error("at is empty — the dashboard badges freshness from it")
	}

	// Order is Registry.List's contract (id, then version).
	for i, want := range pinned {
		e := got.Strategies[i]
		if e.ID != want.ID || e.Version != want.Version || e.File != want.File {
			t.Errorf("entry %d = %s@%s (%s), want %s@%s (%s)", i, e.ID, e.Version, e.File, want.ID, want.Version, want.File)
		}
		if e.SHA256 != want.SHA256 || len(e.SHA256) != 64 {
			t.Errorf("%s@%s sha256 = %q, want the artifact hash %q", e.ID, e.Version, e.SHA256, want.SHA256)
		}
		if e.Configuration == nil {
			t.Errorf("%s@%s configuration is null — the UI shows real params", e.ID, e.Version)
		}
	}
}

// The served sha256 must be the hash of the bytes on disk, not a hand-typed
// string: that is what makes "this is the artifact I will run" checkable.
func TestRegistryEndpointHashesMatchArtifactsOnDisk(t *testing.T) {
	srv, _ := registryServer(t)

	res, err := http.Get(srv.URL)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer res.Body.Close()
	var got RegistryResponse
	if err := json.NewDecoder(res.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}

	for _, e := range got.Strategies {
		raw, err := os.ReadFile(filepath.Join("samples", e.File))
		if err != nil {
			t.Fatalf("read %s: %v", e.File, err)
		}
		sum := sha256.Sum256(raw)
		if want := hex.EncodeToString(sum[:]); e.SHA256 != want {
			t.Errorf("%s@%s sha256 = %q, want %q", e.ID, e.Version, e.SHA256, want)
		}
	}
}

// The catalog labels live in registry.json; a hardcoded copy in the dashboard is
// exactly the drift this endpoint removes.
func TestRegistryEndpointCarriesCatalogLabels(t *testing.T) {
	srv, _ := registryServer(t)

	res, err := http.Get(srv.URL)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer res.Body.Close()
	var got RegistryResponse
	if err := json.NewDecoder(res.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}

	byKey := map[string]RegistryEntry{}
	for _, e := range got.Strategies {
		byKey[e.ID+"@"+e.Version] = e
	}
	golden, ok := byKey["sma-cross@0.1.0"]
	if !ok {
		t.Fatal("sma-cross@0.1.0 missing from the catalog")
	}
	if golden.Name != "SMA Cross (fast)" {
		t.Errorf("name = %q, want %q", golden.Name, "SMA Cross (fast)")
	}
	if golden.Description != "fast 2 / slow 3 — golden fixture" {
		t.Errorf("description = %q", golden.Description)
	}
	// The configuration is the REAL baseline the runner merges under a request
	// overlay — JSON numbers decode as float64.
	if v, ok := golden.Configuration["fast_window"].(float64); !ok || v != 2 {
		t.Errorf("fast_window = %v, want 2", golden.Configuration["fast_window"])
	}
	if len(byKey) != 4 {
		t.Errorf("catalog has %d entries, want the 4 pinned samples", len(byKey))
	}
}

func TestRegistryEndpointIsReadOnlyGET(t *testing.T) {
	srv, _ := registryServer(t)

	res, err := http.Post(srv.URL, "application/json", nil)
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("POST status = %d, want 405", res.StatusCode)
	}
}

func TestRegistryEndpointPreflightIsCORSReadable(t *testing.T) {
	srv, _ := registryServer(t)

	req, err := http.NewRequest(http.MethodOptions, srv.URL, nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("OPTIONS: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusNoContent {
		t.Errorf("OPTIONS status = %d, want 204", res.StatusCode)
	}
	if got := res.Header.Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("allow-origin = %q, want *", got)
	}
	if got := res.Header.Get("Access-Control-Allow-Methods"); got != "GET, OPTIONS" {
		t.Errorf("allow-methods = %q, want %q", got, "GET, OPTIONS")
	}
}
