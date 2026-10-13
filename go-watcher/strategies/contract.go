// Contract mirrors the JSON keys of the E13 strategy schemas (draft-07).
// Only the fields the runner needs to build/validate are modelled; the
// rest of the document passes through opaquely. Exact-price arithmetic is
// decimal-string based — the runner never parses a price as float64 for
// policy decisions, only for indicator math inside strategies.
package strategies

// MarketSnapshot is schemas §invocation.market_snapshot plus the optional
// candle window the deep-analysis path attaches for strategy authors.
// Single-tick mode (empty Candles) is the tick-time contract; Candles mode
// is the deep-analysis extension — the schema requires only symbol/px/ts/src,
// so both shapes validate.
type MarketSnapshot struct {
	Symbol string `json:"symbol"`
	Px     string `json:"px"`
	Ts     string `json:"ts"`
	Src    string `json:"src"`
	PrevPx string `json:"prev_px,omitempty"`
	StaleS *float64 `json:"stale_s,omitempty"`
	// Candles is the deep-analysis extension: oldest-first OHLC closes with
	// per-candle ms timestamps. Absent for tick-time invocations.
	Candles []Candle `json:"candles,omitempty"`
}

// Candle is one OHLCV bar. All numerics are decimal strings (exact wire
// format); indicator math parses them inside the strategy, never here.
type Candle struct {
	Ts     int64  `json:"ts"`
	Open   string `json:"open"`
	High   string `json:"high"`
	Low    string `json:"low"`
	Close  string `json:"close"`
	Volume string `json:"volume"`
}

// ExecutionContext is schemas §invocation.execution_context.
type ExecutionContext struct {
	AsOfTS    string `json:"asof_ts"`
	DeadlineMs int   `json:"deadline_ms"`
	TraceID   string `json:"trace_id"`
}

// Invocation is the strategy-invocation-v1 document the runner feeds to the
// WASM module's stdin.
type Invocation struct {
	ContractVersion       string            `json:"contract_version"`
	StrategyID            string            `json:"strategy_id"`
	StrategyVersion       string            `json:"strategy_version"`
	InvocationID          string            `json:"invocation_id"`
	MarketSnapshot        MarketSnapshot    `json:"market_snapshot"`
	StrategyConfiguration map[string]any    `json:"strategy_configuration"`
	PreviousState         map[string]any    `json:"previous_state"`
	ExecutionContext      ExecutionContext  `json:"execution_context"`
}

// Decision is schemas §result.decision.
type Decision struct {
	Bias       string  `json:"bias"`
	Confidence float64 `json:"confidence"`
}

// Signal is schemas §result.signals[].
type Signal struct {
	Kind   string `json:"kind"`
	Symbol string `json:"symbol"`
}

// Diagnostics is schemas §result.diagnostics.
type Diagnostics struct {
	Reason string   `json:"reason"`
	Code   string   `json:"code"`
	Logs   []string `json:"logs,omitempty"`
}

// Result is the strategy-result-v1 document the module must print to stdout.
type Result struct {
	ContractVersion string            `json:"contract_version"`
	StrategyID      string            `json:"strategy_id"`
	StrategyVersion string            `json:"strategy_version"`
	InvocationID    string            `json:"invocation_id"`
	Status          string            `json:"status"`
	Decision        Decision          `json:"decision"`
	Signals         []Signal          `json:"signals"`
	ProposedState   map[string]any    `json:"proposed_state"`
	Diagnostics     Diagnostics       `json:"diagnostics"`
}
