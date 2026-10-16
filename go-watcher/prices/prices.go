// Package prices — live market snapshots for the advisory chat plane.
//
// The chat model has no market access of its own: every price it quotes must
// be injected here, by Go, before the turn reaches the Worker AI binding.
// Sources, in priority order (mirrors the strategies klines pairing, D-06):
//
//  1. Redis px:{symbol} — the WS-normalized last tick (TTL 30s, set by the
//     watcher's market loop). Cheapest and freshest when the WS plane is up.
//  2. Toobit public REST ticker — same fallback provider /analyze uses when
//     Redis has nothing (cold start, restart, degraded plane).
//  3. Binance public REST — second leg of the pairing, symbol-compatible
//     (BTCUSDT/ETHUSDT/SOLUSDT).
//
// Unknown data is reported as unavailable, NEVER interpolated: the model is
// told the age and source of every number it is given (ADR-004 discipline
// carries into the chat context — "best-effort degraded quotes" stays
// labelled). Chat is advisory, so a total fetch failure degrades the answer,
// not the service: the caller gets an empty snapshot and the turn proceeds
// with an explicit "market data unavailable" system line.
package prices

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"trading-agent/go-watcher/normalize"
	"trading-agent/go-watcher/redisx"
)

const (
	// timeout bounds the whole snapshot (all sources) — chat must never wait
	// on a slow venue: the model answers faster with "unavailable" than with
	// a hung HTTP client.
	timeout = 6 * time.Second
	// restTimeout bounds one individual provider call inside the snapshot.
	restTimeout = 3 * time.Second
	// staleAfter marks a Redis px as too old to quote as live. Ticks carry
	// TTL 30s; anything approaching it is worth labelling degraded anyway.
	staleAfter = 15 * time.Second
)

// DefaultSymbols are the majors the model is expected to know live
// (freshness.Default majors + the canonical watch set of docs/06).
func DefaultSymbols() []string { return []string{"BTCUSDT", "ETHUSDT", "SOLUSDT"} }

// Price is one symbol's snapshot as handed to the model.
type Price struct {
	Symbol string `json:"symbol"`
	Px     string `json:"px"`     // decimal string — never float (repo-wide rule)
	Ts     int64  `json:"ts"`     // exchange/source ms timestamp
	Src    string `json:"src"`    // redis-ws | toobit-rest | binance-rest
	AgeMs  int64  `json:"age_ms"` // now - Ts (negative = clock skew)
	Stale  bool   `json:"stale"`  // older than staleAfter
}

// Snapshot is the full result handed to the chat assembler.
type Snapshot struct {
	At     int64   `json:"at"`
	Prices []Price `json:"prices"`
	// Missing lists symbols no source could answer for. The model MUST be
	// told, or it will happily fill the gap with training-data prices.
	Missing []string `json:"missing,omitempty"`
}

// Has reports whether any symbol got a usable price.
func (s Snapshot) Has() bool { return len(s.Prices) > 0 }

// Get returns the price for a symbol (ok=false when absent).
func (s Snapshot) Get(symbol string) (Price, bool) {
	for _, p := range s.Prices {
		if strings.EqualFold(p.Symbol, symbol) {
			return p, true
		}
	}
	return Price{}, false
}

// Fetch assembles a snapshot for symbols. ctx should carry the caller's
// deadline; it is additionally bounded by timeout. Never errors — a failure
// in every source is an empty Snapshot with all symbols Missing, because the
// chat path must degrade (advisory), not fail (fail-closed is for trading).
func Fetch(ctx context.Context, symbols []string) Snapshot {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	if len(symbols) == 0 {
		symbols = DefaultSymbols()
	}
	now := time.Now()
	snap := Snapshot{At: now.UnixMilli()}

	// Pass 1: Redis last-tick (~1ms per symbol on the local RESP client).
	// ctx is threaded in so the 6s Fetch bound is real even when Redis is
	// blackholed rather than refusing: redisx has its own per-call deadline,
	// but only Fetch's ctx can stop the loop between symbols.
	remaining := make([]string, 0, len(symbols))
	for _, sym := range symbols {
		sym = strings.ToUpper(strings.TrimSpace(sym))
		if sym == "" {
			continue
		}
		if ctx.Err() != nil {
			// Out of time: everything not yet resolved goes to REST (which
			// will also fail fast) and is then reported Missing. Truthful
			// degradation beats a hung chat turn.
			remaining = append(remaining, sym)
			continue
		}
		if p, ok := fromRedis(ctx, sym, now); ok {
			snap.Prices = append(snap.Prices, p)
		} else {
			remaining = append(remaining, sym)
		}
	}

	// Pass 2: REST fallback for the rest (Toobit then Binance, per symbol).
	for _, sym := range remaining {
		p, ok := fromREST(ctx, sym, now)
		if !ok {
			snap.Missing = append(snap.Missing, sym)
			continue
		}
		snap.Prices = append(snap.Prices, p)
	}

	sort.Slice(snap.Prices, func(i, j int) bool { return snap.Prices[i].Symbol < snap.Prices[j].Symbol })
	sort.Strings(snap.Missing)
	return snap
}

// fromRedis reads px:{sym} (HASH px, ts — the watcher's normalize contract).
// ok=false on missing key, bad values, or a tick aged past staleAfter (the
// REST pass then either answers fresher or the symbol truthfully goes Missing).
// An already-expired ctx short-circuits without dialing.
func fromRedis(ctx context.Context, symbol string, now time.Time) (Price, bool) {
	if ctx.Err() != nil {
		return Price{}, false
	}
	px, err := redisx.Do("HGET", "px:"+symbol, "px")
	if err != nil || px == "" {
		return Price{}, false
	}
	tsRaw, err := redisx.Do("HGET", "px:"+symbol, "ts")
	if err != nil {
		return Price{}, false
	}
	ts, err := strconv.ParseInt(strings.TrimSpace(tsRaw), 10, 64)
	if err != nil || ts <= 0 {
		return Price{}, false
	}
	age := now.UnixMilli() - ts
	if age > staleAfter.Milliseconds() {
		return Price{}, false
	}
	return Price{
		Symbol: symbol, Px: px, Ts: ts, Src: "redis-ws",
		AgeMs: age, Stale: age < 0, // negative = future tick (clock skew), flagged not aged
	}, true
}

// fromREST tries Toobit then Binance public tickers — no keys (T1: public
// market data only), the exact pairing strategies/klines.go established.
func fromREST(ctx context.Context, symbol string, now time.Time) (Price, bool) {
	if p, ok := toobitTicker(ctx, symbol, now); ok {
		return p, true
	}
	return binanceTicker(ctx, symbol, now)
}

// toobitTicker: GET {TOOBIT_BASE|https://api.toobit.com}/quote/v1/contract/ticker/price?symbol=
//
// Verified live 2026-10-16 (docs/ops/TOOBIT-API-FACTS.md S2a): the filtered form
// answers [{"s":"BTCUSDT","p":"82440"}] in the CANONICAL symbol form, while
// `?symbols=` is IGNORED and answers the whole venue in the dash form. The path
// used to be /api/v1/... — a 404 — so every Toobit quote silently fell through to
// Binance and the chat reported "market data unavailable" instead of a price.
func toobitTicker(ctx context.Context, symbol string, now time.Time) (Price, bool) {
	base := os.Getenv("TOOBIT_BASE")
	if base == "" {
		base = "https://api.toobit.com"
	}
	base = strings.TrimRight(base, "/")
	u := base + "/quote/v1/contract/ticker/price?symbol=" + symbol
	var rows []struct {
		S      string          `json:"s"` // canonical filtered form
		P      json.RawMessage `json:"p"`
		Symbol string          `json:"symbol"` // tolerate the object form too
		Price  json.RawMessage `json:"price"`
	}
	if err := getJSON(ctx, u, &rows); err != nil || len(rows) == 0 {
		return Price{}, false
	}
	row := rows[0]
	raw := row.P
	if len(raw) == 0 {
		raw = row.Price
	}
	px, ok := rawDecimal(raw)
	if !ok || px == "" {
		return Price{}, false
	}
	// The filtered endpoint answers the canonical symbol; if the venue ever
	// answers a different market, it must NOT be quoted as this one.
	if row.S != "" && normalize.ToCanonical(row.S) != normalize.ToCanonical(symbol) {
		return Price{}, false
	}
	return Price{Symbol: symbol, Px: px, Ts: now.UnixMilli(), Src: "toobit-rest"}, true
}

// binanceTicker: GET https://api.binance.com/api/v3/ticker/price?symbol=
// {symbol, price} with price as a numeric string.
func binanceTicker(ctx context.Context, symbol string, now time.Time) (Price, bool) {
	u := "https://api.binance.com/api/v3/ticker/price?symbol=" + symbol
	var body struct {
		Symbol string `json:"symbol"`
		Price  string `json:"price"`
	}
	if err := getJSON(ctx, u, &body); err != nil {
		return Price{}, false
	}
	px, ok := decimalString(body.Price)
	if !ok {
		return Price{}, false
	}
	return Price{Symbol: symbol, Px: px, Ts: now.UnixMilli(), Src: "binance-rest"}, true
}

// getJSON is the bounded GET + decode (mirrors strategies.getJSON, with ctx).
func getJSON(ctx context.Context, url string, v any) error {
	rctx, cancel := context.WithTimeout(ctx, restTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(rctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(v)
}

// rawDecimal renders a JSON scalar (string or number) as a canonical decimal
// string, rejecting anything non-numeric — the model must never receive a
// malformed number as "the price".
func rawDecimal(raw json.RawMessage) (string, bool) {
	if len(raw) == 0 {
		return "", false
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return decimalString(s)
	}
	var f float64
	if json.Unmarshal(raw, &f) == nil {
		return decimalString(strconv.FormatFloat(f, 'f', -1, 64))
	}
	return "", false
}

// decimalString validates + canonicalizes; rejects empty, non-positive and
// non-finite (a venue glitch — a zeroed or negative quote must never reach the
// model as truth; price 0 is not a price, it is a missing value).
func decimalString(s string) (string, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", false
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil || f <= 0 || f != f || f > 1e18 {
		return "", false
	}
	return strconv.FormatFloat(f, 'f', -1, 64), true
}
