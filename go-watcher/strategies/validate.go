// Result validation: the load-bearing subset of strategy-result.schema.
// Echo fields bind every result to its invocation; the enums and confidence
// range are the fail-closed gates (a strategy that cannot speak the contract
// cannot move the aggregate).
package strategies

import "fmt"

// validateResult enforces contract pin, id echoes, status/bias enums,
// confidence range and reason presence.
func validateResult(inv Invocation, res Result) error {
	if res.ContractVersion != "1" {
		return fmt.Errorf("contract_version must be \"1\", got %q", res.ContractVersion)
	}
	if res.StrategyID != inv.StrategyID {
		return fmt.Errorf("strategy_id echo %q != invocation %q", res.StrategyID, inv.StrategyID)
	}
	if res.StrategyVersion != inv.StrategyVersion {
		return fmt.Errorf("strategy_version echo %q != invocation %q", res.StrategyVersion, inv.StrategyVersion)
	}
	if res.InvocationID != inv.InvocationID {
		return fmt.Errorf("invocation_id echo %q != invocation %q", res.InvocationID, inv.InvocationID)
	}
	switch res.Status {
	case "SIGNAL", "NO_SIGNAL", "ERROR":
	default:
		return fmt.Errorf("status %q not SIGNAL|NO_SIGNAL|ERROR", res.Status)
	}
	switch res.Decision.Bias {
	case "LONG", "SHORT", "FLAT":
	default:
		return fmt.Errorf("decision.bias %q not LONG|SHORT|FLAT", res.Decision.Bias)
	}
	if !(res.Decision.Confidence >= 0 && res.Decision.Confidence <= 1) {
		return fmt.Errorf("decision.confidence %v out of [0,1]", res.Decision.Confidence)
	}
	if res.Diagnostics.Reason == "" {
		return fmt.Errorf("diagnostics.reason required")
	}
	switch res.Diagnostics.Code {
	case "OK", "VALIDATION", "TIMEOUT", "CANCELLED", "OOM", "PANIC", "OUTPUT_TOO_LARGE", "CONTRACT_MISMATCH":
	default:
		return fmt.Errorf("diagnostics.code %q unknown", res.Diagnostics.Code)
	}
	return nil
}

// errorResult builds the ERROR envelope the contract requires for faulty
// runs. Echo fields always bind the fault to its invocation.
func errorResult(inv Invocation, code, reason string) Result {
	if reason == "" {
		reason = "fault: " + code
	}
	return Result{
		ContractVersion: "1",
		StrategyID:      inv.StrategyID,
		StrategyVersion: inv.StrategyVersion,
		InvocationID:    inv.InvocationID,
		Status:          "ERROR",
		Decision:        Decision{Bias: "FLAT", Confidence: 0},
		Signals:         []Signal{},
		ProposedState:   map[string]any{},
		Diagnostics:     Diagnostics{Reason: reason, Code: code},
	}
}
