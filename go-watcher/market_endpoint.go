// Market-data endpoints for the CONTROL PLANE (the Worker).
//
// WHY THESE EXIST (2026-11-08): the venue answers HTTP 403 to Cloudflare's
// egress while answering this host happily — so `/api/symbols` collapsed onto
// the Worker's own D1 rows (four symbols) and `/api/prices` returned
// `prices: {}` with every symbol "missing", leaving the cockpit with no
// catalog and no number at all. ADR-004's deferred alternative D ("add a
// different venue as the Worker's symbol source") is answered here instead by
// the platform's OWN second egress: the Worker keeps its venue-first read and
// falls back to these two routes when the venue refuses it.
//
// Both routes are READ-ONLY market data: public, keyless, no order, no
// approval, no D1 write. They are the same reads `/analyze` already performs
// (toobit-rest tickers), exposed in the shape the Worker's fail-soft paths
// need. `/api/market/prices` reuses prices.Fetch, so the Redis last-tick →
// Toobit REST → Binance REST pairing and its "unknown is MISSING, never
// interpolated" discipline are inherited rather than re-implemented.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"trading-agent/go-watcher/prices"
)

// maxMarketSymbols mirrors workers/src/quotes.mjs MAX_FILTERED: the Worker
// never asks for more than this, so an oversized request is a caller bug, not
// something worth paying for.
const maxMarketSymbols = 25

// marketTimeout bounds one whole request — a dashboard tick must never wait on
// a slow venue (the Worker's own ceiling is 6s).
const marketTimeout = 8 * time.Second

func writeMarketJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("content-type", "application/json")
	// CORS like serveRegistry: a browser that talks to this host directly (the
	// dashboard falls back to it when no Worker base is baked in) must be able
	// to READ an error instead of seeing an opaque network failure.
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeMarketErr(w http.ResponseWriter, status int, code, msg string) {
	writeMarketJSON(w, status, map[string]string{"code": code, "message": msg})
}

// serveMarketSymbols — GET /api/market/symbols
//
//	200 {"symbols":["BTCUSDT",...],"source":"toobit-rest","at":"<rfc3339>"}
//	502 {"code":"MARKET_UNAVAILABLE","message":"venue symbols: ..."}
func serveMarketSymbols(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeMarketErr(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "GET only")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), marketTimeout)
	defer cancel()
	symbols, source, err := prices.Symbols(ctx)
	if err != nil {
		// Fail LOUD, not empty: an empty 200 would render as "the venue lists
		// nothing" and the Worker would prefer it over its own D1 fallback.
		writeMarketErr(w, http.StatusBadGateway, "MARKET_UNAVAILABLE", err.Error())
		return
	}
	writeMarketJSON(w, http.StatusOK, struct {
		Symbols []string `json:"symbols"`
		Source  string   `json:"source"`
		At      string   `json:"at"`
	}{symbols, source, time.Now().UTC().Format(time.RFC3339)})
}

// serveMarketPrices — GET /api/market/prices?symbols=BTCUSDT,ETHUSDT
//
//	200 {"at":<ms>,"prices":[{"symbol","px","ts","src","age_ms","stale"}],"missing":["..."]}
//	400 {"code":"VALIDATION",...}   502 {"code":"MARKET_UNAVAILABLE",...}
//
// Unanswered symbols stay in `missing` — a price is never invented here either.
func serveMarketPrices(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeMarketErr(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "GET only")
		return
	}
	wanted := parseSymbolList(r.URL.Query().Get("symbols"))
	if len(wanted) == 0 {
		writeMarketErr(w, http.StatusBadRequest, "VALIDATION", "symbols param required (comma-separated, canonical form)")
		return
	}
	if len(wanted) > maxMarketSymbols {
		writeMarketErr(w, http.StatusBadRequest, "VALIDATION",
			fmt.Sprintf("too many symbols (%d) — max %d per call", len(wanted), maxMarketSymbols))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), marketTimeout)
	defer cancel()
	snap := prices.Fetch(ctx, wanted)
	writeMarketJSON(w, http.StatusOK, struct {
		At      int64          `json:"at"`
		Prices  []prices.Price `json:"prices"`
		Missing []string       `json:"missing"`
	}{snap.At, snap.Prices, snap.Missing})
}

// parseSymbolList splits + uppercases + dedupes + validates the query param.
// An invalid token is simply dropped: prices.Fetch would only produce a
// Missing entry for it after paying for a venue round-trip.
func parseSymbolList(raw string) []string {
	seen := make(map[string]struct{})
	out := make([]string, 0, 4)
	for _, part := range strings.Split(raw, ",") {
		s := strings.ToUpper(strings.TrimSpace(part))
		if !prices.ValidSymbol(s) {
			continue
		}
		if _, dup := seen[s]; dup {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	return out
}

