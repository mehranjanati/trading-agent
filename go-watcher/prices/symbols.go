// Symbols: the venue's USDT-M perpetual CATALOG, as served to the control
// plane (Workers) when Cloudflare's egress is refused.
//
// WHY THE GO PLANE SERVES THE CATALOG AT ALL: the venue answers HTTP 403 to
// the Worker's Cloudflare egress IP while the SAME URL answers 200 from this
// host (verified 2026-11-07/08; see docs/ops/TOOBIT-API-FACTS.md). The Worker
// therefore fell back to its own D1 rows — the ACTIVE allowlist plus whatever
// it had already seen in watches/positions — and the dashboard's picker showed
// FOUR symbols out of ~773 listed markets. ADR-004 listed "a different venue as
// the Worker's symbol source" as deferred with the trigger "revisit if the D1
// set proves too narrow in practice": it did. The answer is not a fourth third
// party, it is the platform's OWN second egress (this process), which the venue
// demonstrably answers.
//
// The form rules are the same ones the Worker and klines.go already enforce
// (TOOBIT-API-FACTS S4): only rows carrying the `-SWAP-` infix are USDT-M
// perpetuals — a dash-free row from this endpoint is the SPOT book and must
// never enter the tradeable universe — and the answer is canonicalised to the
// repo-wide form (BTC-SWAP-USDT → BTCUSDT) via normalize.ToCanonical.
package prices

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"

	"trading-agent/go-watcher/normalize"
)

// symbolRE is the repo-wide canonical symbol form, mirrored EXACTLY from
// workers/src/symbols.mjs SYMBOL_RE and dashboard/src/lib/symbols.ts SYM_RE.
// Keeping the three in sync is what makes one symbol identity across planes:
// a symbol this process lists is a symbol the Worker accepts and the risk gate
// can match (R-SYM).
var symbolRE = regexp.MustCompile(`^[A-Z]{2,12}USDT$`)

// ValidSymbol reports whether s is a canonical symbol this platform trades.
func ValidSymbol(s string) bool { return symbolRE.MatchString(strings.TrimSpace(s)) }

// symbolsPath is the venue's contract ticker (weight 1, all markets, no key).
// It is the SAME endpoint the Worker uses — this is not a new data source, it
// is the same read from an egress the venue accepts.
const symbolsPath = "/quote/v1/contract/ticker/price"

// TickerRow is one unfiltered venue ticker row. `p` arrives as a string today
// and as a number on some endpoints, so it is decoded raw and validated.
type TickerRow struct {
	S string          `json:"s"`
	P json.RawMessage `json:"p"`
}

// VenueTickers is the ONE unfiltered venue read that answers a whole BATCH.
//
// WHY ONE READ FOR A BATCH (2026-11-08): the Worker asks for up to 25 symbols at
// a time (every symbol a cockpit sidebar draws), and one request per symbol
// turned out to be both slower and MORE expensive than a single read: the venue
// allows 50 requests/s but its TLS handshake alone measured 6.8s during a bad
// minute, so 25 parallel per-symbol reads either timed out or blew the caller's
// deadline — the desk showed "price UNAVAILABLE ... venue HTTP 403" for symbols
// the venue was answering. One unfiltered request is ONE weight-1 read (vs 25),
// ONE handshake, and the same payload the catalog already reads.
//
// The venue-form guard still applies: only `-SWAP-` rows are USDT-M
// perpetuals; a dash-free row is the spot book and is refused.
func VenueTickers(ctx context.Context) (map[string]string, error) {
	base := strings.TrimRight(os.Getenv("TOOBIT_BASE"), "/")
	if base == "" {
		base = "https://api.toobit.com"
	}
	var rows []TickerRow
	if err := getJSONWithin(ctx, base+symbolsPath, &rows, batchTimeout); err != nil {
		return nil, fmt.Errorf("venue ticker: %w", err)
	}
	out := ParseVenueTickers(rows)
	if len(out) == 0 {
		return nil, fmt.Errorf("venue ticker: no USDT-M prices in the answer (%d rows)", len(rows))
	}
	return out, nil
}

// ParseVenueTickers canonicalises an unfiltered ticker answer into
// symbol → decimal price. Exported so the shape rules are testable offline:
// spot echoes, USDC-margined contracts and non-positive prices never enter.
func ParseVenueTickers(rows []TickerRow) map[string]string {
	out := make(map[string]string, len(rows))
	for _, r := range rows {
		up := strings.ToUpper(strings.TrimSpace(r.S))
		if !strings.Contains(up, "-SWAP-") {
			continue
		}
		sym := normalize.ToCanonical(up)
		if !symbolRE.MatchString(sym) {
			continue
		}
		px, ok := rawDecimal(r.P)
		if !ok || px == "" {
			continue
		}
		out[sym] = px
	}
	return out
}

// Symbols returns the venue catalog in canonical form, sorted and deduped.
// source names the provider ("toobit-rest") so a caller can label it.
//
// It NEVER invents: a failed read is an error, not an empty success — an empty
// catalog would look like "the venue lists nothing", which is a lie the picker
// would then render.
func Symbols(ctx context.Context) ([]string, string, error) {
	base := strings.TrimRight(os.Getenv("TOOBIT_BASE"), "/")
	if base == "" {
		base = "https://api.toobit.com"
	}
	var raw json.RawMessage
	if err := getJSON(ctx, base+symbolsPath, &raw); err != nil {
		return nil, "", fmt.Errorf("venue symbols: %w", err)
	}
	out := ParseVenueSymbols(raw)
	if len(out) == 0 {
		return nil, "", fmt.Errorf("venue symbols: no USDT-M markets in the answer (%d bytes)", len(raw))
	}
	return out, "toobit-rest", nil
}

// ParseVenueSymbols canonicalises + dedupes the raw venue ticker answer.
// Exported so the endpoint's contract is testable without a live venue.
//
// Both wire shapes are tolerated (a bare array, or {"data":[...]}) because the
// venue has answered both; anything else is an empty list, never a panic.
func ParseVenueSymbols(body []byte) []string {
	type row struct {
		S      string `json:"s"`
		Symbol string `json:"symbol"`
	}
	var rows []row
	if err := json.Unmarshal(body, &rows); err != nil {
		var envelope struct {
			Data []row `json:"data"`
		}
		if err := json.Unmarshal(body, &envelope); err != nil {
			return nil
		}
		rows = envelope.Data
	}
	seen := make(map[string]struct{}, len(rows))
	out := make([]string, 0, len(rows))
	for _, r := range rows {
		raw := r.S
		if raw == "" {
			raw = r.Symbol
		}
		up := strings.ToUpper(strings.TrimSpace(raw))
		// Futures rows carry the `-SWAP-` infix; a dash-free row is the SPOT
		// book (same guard as the Worker's parseSymbols) and is refused, as are
		// the USDC-margined contracts.
		if up == "" || !strings.Contains(up, "-SWAP-") {
			continue
		}
		sym := normalize.ToCanonical(up)
		if !symbolRE.MatchString(sym) {
			continue
		}
		if _, dup := seen[sym]; dup {
			continue
		}
		seen[sym] = struct{}{}
		out = append(out, sym)
	}
	sort.Strings(out)
	if len(out) == 0 {
		// nil, not an empty slice: "no USDT-M market in this answer" must be
		// indistinguishable from "this was not a catalog at all", so no caller
		// can mistake one for a venue that lists nothing.
		return nil
	}
	return out
}
