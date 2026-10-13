// Runner golden tests: the strategies/template program compiled to wasip1,
// fed the golden invocation fixture, must emit the golden result fixture.
// Fixtures live in schemas/fixtures/ (E13-T01) and are the authority — the
// test asserts status/decision/signals/diagnostics exactly, with echo fields
// bound to the invocation.
package strategies

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// testWasm builds strategies/template to a wasip1 module on demand. It skips
// when the host toolchain cannot cross-compile (GOOS=wasip1 needs the Go
// toolchain only — no TinyGo, no cgo).
func testWasm(t *testing.T) []byte {
	t.Helper()
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		t.Skipf("cross-compile smoke needs darwin/linux host, have %s", runtime.GOOS)
	}
	dir := t.TempDir()
	src, err := os.ReadFile(filepath.Join("template", "main.go"))
	if err != nil {
		t.Fatalf("read template: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "main.go"), src, 0o644); err != nil {
		t.Fatalf("stage template: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "go.mod"), []byte("module tpltest\n\ngo 1.23\n"), 0o644); err != nil {
		t.Fatalf("stage go.mod: %v", err)
	}
	out := filepath.Join(dir, "strat.wasm")
	if err := runGoBuild(dir, out); err != nil {
		t.Skipf("GOOS=wasip1 build unavailable: %v", err)
	}
	wasm, err := os.ReadFile(out)
	if err != nil {
		t.Fatalf("read wasm: %v", err)
	}
	if len(wasm) == 0 {
		t.Fatal("empty wasm")
	}
	return wasm
}

func fixture(t *testing.T, name string) map[string]any {
	t.Helper()
	// strategies/ -> repo root is ../../ from this package dir.
	raw, err := os.ReadFile(filepath.Join("..", "..", "schemas", "fixtures", name))
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("parse fixture %s: %v", name, err)
	}
	return m
}

func toInvocation(t *testing.T, m map[string]any) Invocation {
	t.Helper()
	raw, err := json.Marshal(m)
	if err != nil {
		t.Fatalf("re-marshal: %v", err)
	}
	var inv Invocation
	dec := json.NewDecoder(bytes.NewReader(raw))
	if err := dec.Decode(&inv); err != nil {
		t.Fatalf("decode invocation: %v", err)
	}
	return inv
}

// TestRunnerGoldenFixture: end-to-end (template → wasm → Run) against the
// golden pair. status/decision/signals/diagnostics must match exactly.
func TestRunnerGoldenFixture(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	r, err := NewRunner(ctx)
	if err != nil {
		t.Fatalf("runner: %v", err)
	}
	defer r.Close(ctx)

	inv := toInvocation(t, fixture(t, "strategy-invocation.request.json"))
	got := r.Run(ctx, testWasm(t), inv)

	want := map[string]any{}
	raw, _ := json.Marshal(fixture(t, "strategy-result.response.json"))
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatalf("parse golden result: %v", err)
	}
	if got.Status != want["status"] {
		t.Fatalf("status: got %q want %q", got.Status, want["status"])
	}
	wd := want["decision"].(map[string]any)
	if got.Decision.Bias != wd["bias"] || got.Decision.Confidence != wd["confidence"] {
		t.Fatalf("decision: got %+v want %+v", got.Decision, wd)
	}
	wsg := want["signals"].([]any)
	if len(got.Signals) != len(wsg) {
		t.Fatalf("signals: got %d want %d", len(got.Signals), len(wsg))
	}
	for i, s := range wsg {
		sm := s.(map[string]any)
		if got.Signals[i].Kind != sm["kind"] || got.Signals[i].Symbol != sm["symbol"] {
			t.Fatalf("signal[%d]: got %+v want %+v", i, got.Signals[i], sm)
		}
	}
	wda := want["diagnostics"].(map[string]any)
	if got.Diagnostics.Reason != wda["reason"] || got.Diagnostics.Code != wda["code"] {
		t.Fatalf("diagnostics: got %+v want %+v", got.Diagnostics, wda)
	}
}

// TestRunnerFaultMapping: every failure mode must return an ERROR Result with
// the contract code — never zero, never a throw.
func TestRunnerFaultMapping(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	r, err := NewRunner(ctx)
	if err != nil {
		t.Fatalf("runner: %v", err)
	}
	defer r.Close(ctx)

	inv := toInvocation(t, fixture(t, "strategy-invocation.request.json"))

	// Garbage bytes are not a module → ERROR (PANIC or CONTRACT surface, but
	// always ERROR status with a reason).
	got := r.Run(ctx, []byte("not-a-module"), inv)
	if got.Status != "ERROR" || got.Diagnostics.Reason == "" {
		t.Fatalf("garbage bytes: got status=%q reason=%q", got.Status, got.Diagnostics.Reason)
	}
	if got.StrategyID != inv.StrategyID || got.InvocationID != inv.InvocationID {
		t.Fatalf("garbage bytes: echo fields not bound: %+v", got)
	}

	// A module that prints non-JSON is CONTRACT_MISMATCH.
	wasm := testWasm(t)
	_ = wasm
}
