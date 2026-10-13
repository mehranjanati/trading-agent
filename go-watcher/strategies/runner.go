// Package strategies runner — wazero execution of versioned AI strategies.
//
// Execution model: one wasip1 command module per strategy version, stdin =
// Invocation JSON, stdout = Result JSON, exit 0. The host grants NOTHING —
// no filesystem, no network, no wall-clock import beyond what wazero's WASI
// gives for time reads inside the sandbox. Every run is bounded by the
// contract deadline_ms (schemas cap 500ms): the run context is cancelled at
// deadline + a small grace, a panic in the guest maps to diagnostics PANIC,
// an overrun maps to TIMEOUT, unparsable stdout maps to CONTRACT_MISMATCH.
// A run that cannot execute at all (bad bytes, OOM on instantiate) maps to
// the ERROR status with the matching diagnostics code — never a throw: the
// analysis aggregate must read one Result per strategy, always.
package strategies

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
)

// execGrace is the extra wall time past the contract deadline before the run
// context is cancelled. The guest cannot see the host clock beyond WASI, so
// the runner owns the budget unilaterally.
const execGrace = 250 * time.Millisecond

// maxOutputBytes caps guest stdout: an oversized result is a protocol
// violation (OUTPUT_TOO_LARGE), not an allocation hazard for the host.
const maxOutputBytes = 256 * 1024

// Runner executes strategy WASM bytes. The runtime is process-scoped and
// shared: wazero compiles modules once per Runtime and instantiating per
// run is the cheap path. Use NewRunner once and call Run per invocation.
type Runner struct {
	rt wazero.Runtime
}

// NewRunner builds the shared process runtime with the WASI preview1 host.
// The caller owns Close.
func NewRunner(ctx context.Context) (*Runner, error) {
	rt := wazero.NewRuntime(ctx)
	if _, err := wasi_snapshot_preview1.Instantiate(ctx, rt); err != nil {
		rt.Close(ctx)
		return nil, fmt.Errorf("strategies: wasi: %w", err)
	}
	return &Runner{rt: rt}, nil
}

// Close releases the shared runtime.
func (r *Runner) Close(ctx context.Context) error {
	if r == nil || r.rt == nil {
		return nil
	}
	return r.rt.Close(ctx)
}

// Run executes one strategy version against one invocation and always
// returns a Result: guest faults are translated to ERROR diagnostics per the
// strategy-result contract (codes TIMEOUT/PANIC/OOM/OUTPUT_TOO_LARGE/
// CONTRACT_MISMATCH/CANCELLED — reason always set, see schemas).
func (r *Runner) Run(parent context.Context, wasm []byte, inv Invocation) Result {
	deadline := time.Duration(inv.ExecutionContext.DeadlineMs) * time.Millisecond
	if deadline <= 0 || deadline > 500*time.Millisecond {
		deadline = 500 * time.Millisecond
	}
	ctx, cancel := context.WithTimeout(parent, deadline+execGrace)
	defer cancel()

	in, err := json.Marshal(inv)
	if err != nil {
		return errorResult(inv, "VALIDATION", "cannot marshal invocation: "+err.Error())
	}

	var stdout, stderr bytes.Buffer
	cfg := wazero.NewModuleConfig().
		WithStdin(bytes.NewReader(in)).
		WithStdout(&stdout).
		WithStderr(&stderr).
		WithEnv("GO_WASM_ARTIFACT", "strategy")

	// Recover a host-side panic in instantiate/run so a faulty guest can
	// never take down the watcher; the fault becomes diagnostics PANIC.
	var runErr error
	func() {
		defer func() {
			if rec := recover(); rec != nil {
				runErr = fmt.Errorf("panic: %v", rec)
			}
		}()
		_, runErr = r.rt.InstantiateWithConfig(ctx, wasm, cfg)
	}()

	if runErr != nil {
		code, msg := faultCode(ctx, inv, runErr)
		if tail := strings.TrimSpace(stderr.String()); tail != "" {
			msg += "; stderr: " + truncate(tail, 512)
		}
		return errorResult(inv, code, msg)
	}
	if stdout.Len() > maxOutputBytes {
		return errorResult(inv, "OUTPUT_TOO_LARGE", fmt.Sprintf("stdout %d bytes > %d cap", stdout.Len(), maxOutputBytes))
	}
	var res Result
	dec := json.NewDecoder(bytes.NewReader(stdout.Bytes()))
	if err := dec.Decode(&res); err != nil {
		return errorResult(inv, "CONTRACT_MISMATCH", "stdout is not a strategy-result document: "+err.Error()+tailOf(stderr.String()))
	}
	if verr := validateResult(inv, res); verr != nil {
		return errorResult(inv, "CONTRACT_MISMATCH", verr.Error())
	}
	return res
}

// faultCode maps a run failure to the contract diagnostics code. A context
// deadline is always the runner's own budget (the guest has no clock), so it
// is TIMEOUT with the exact budget in the message.
func faultCode(ctx context.Context, inv Invocation, runErr error) (string, string) {
	if ctx.Err() == context.DeadlineExceeded {
		return "TIMEOUT", fmt.Sprintf("deadline %dms (+%v grace) exceeded", inv.ExecutionContext.DeadlineMs, execGrace)
	}
	s := strings.ToLower(runErr.Error())
	switch {
	case strings.Contains(s, "out of memory") || strings.Contains(s, "memory."):
		return "OOM", runErr.Error()
	case strings.Contains(s, "closed") || strings.Contains(s, "cancel"):
		return "CANCELLED", runErr.Error()
	default:
		return "PANIC", runErr.Error()
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

func tailOf(s string) string {
	if t := strings.TrimSpace(s); t != "" {
		return "; stderr: " + truncate(t, 512)
	}
	return ""
}
