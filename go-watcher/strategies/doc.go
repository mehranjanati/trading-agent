// Package strategies — AI-strategy runtime contract (E13-T01 seam).
//
// A strategy is a pure program: it reads ONE strategy-invocation-v1 JSON
// document from stdin and writes ONE strategy-result-v1 JSON document to
// stdout, exiting 0. Stdlib-only template in strategies/template/ (what the
// chat later emits). No host capabilities are granted by the runner: no
// filesystem, no network, no clock beyond what the invocation carries.
//
// Contract files (JSON Schema, the authority):
//   schemas/strategy-invocation.schema.json
//   schemas/strategy-result.schema.json
// Golden fixtures: schemas/fixtures/strategy-invocation.request.json and
//   schemas/fixtures/strategy-result.response.json (strategy_id "sma-cross").
package strategies
