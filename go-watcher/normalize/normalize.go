// Package normalize — E02-T02-S2: Toobit tick → canonical Tick (stdlib-only).
// Verified wire shapes (E02-T01, docs/ops/TOOBIT-API-FACTS.md):
//
//	trade: {"symbol":"BTC-SWAP-USDT","topic":"trade","data":[{"v":txid,"t":ms,"p":px,"q":qty,"m":buy?}],"sendTime":ms}
//	markPrice: {"topic":"markPrice","data":[{"symbol":"BTC-SWAP-USDT","markPrice":"...","time":ms}]}
//
// Canonical symbol form in this repo is BTCUSDT (no dashes); WS form is BTC-SWAP-USDT.
package normalize

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// Tick is the canonical normalized tick passed to the watcher (E03).
type Tick struct {
	Symbol string `json:"symbol"`  // canonical, e.g. BTCUSDT
	Price  string `json:"px"`      // decimal string, never float
	Ts     int64  `json:"ts"`      // exchange ms timestamp
	Src    string `json:"src"`     // trade | markPrice | bookTicker
	RecvMs int64  `json:"recv_ms"` // local receipt ms (lag = recv - ts)
	TxID   string `json:"txid"`    // trade v (global incremental), "" for markPrice
}

// ToCanonical maps BTC-SWAP-USDT → BTCUSDT. Unknown forms pass through upper-cased.
func ToCanonical(wsSymbol string) string {
	s := strings.ToUpper(strings.TrimSpace(wsSymbol))
	s = strings.ReplaceAll(s, "-", "")
	s = strings.ReplaceAll(s, "SWAP", "")
	return s
}

// ToVenue maps the canonical form to the venue's FUTURES form
// (BTCUSDT → BTC-SWAP-USDT) — the inverse of ToCanonical.
//
// Required by the WS subscribe message AND every Toobit REST market-data call:
// the symbol form selects the market. Toobit answers `?symbol=BTCUSDT` from its
// SPOT book even on /quote/v1/contract/..., while `BTC-SWAP-USDT` is the USDT-M
// perpetual (verified 2026-10-26, docs/ops/TOOBIT-API-FACTS.md S4:
// BTCUSDT 80312.09 vs BTC-SWAP-USDT 80287.40 in the same second).
//
// Non-USDT symbols pass through: our venue lists USDT-M perpetuals only, so a
// cross like ETHBTC has no venue form (and 400s if asked).
func ToVenue(canonical string) string {
	// Idempotent: accept either identity (BTCUSDT) or an already-venue form
	// (BTC-SWAP-USDT / btc-usdt) so call sites cannot double-append the infix.
	s := ToCanonical(canonical)
	if strings.HasSuffix(s, "USDT") && len(s) > 4 {
		return s[:len(s)-4] + "-SWAP-USDT"
	}
	return s
}

// wireTrade mirrors the trade topic envelope.
type wireTrade struct {
	Symbol string `json:"symbol"`
	Topic  string `json:"topic"`
	Data   []struct {
		V string `json:"v"`
		T int64  `json:"t"`
		P string `json:"p"`
		Q string `json:"q"`
		M bool   `json:"m"`
	} `json:"data"`
}

// wireMark mirrors the markPrice envelope.
type wireMark struct {
	Topic string `json:"topic"`
	Data  []struct {
		Symbol    string `json:"symbol"`
		MarkPrice string `json:"markPrice"`
		Time      int64  `json:"time"`
	} `json:"data"`
}

// ParseTrade decodes one trade-topic message into ticks (one per deal).
// Malformed deals are skipped and counted (returned), never panic.
func ParseTrade(raw []byte, recvMs int64) (ticks []Tick, dropped int) {
	var w wireTrade
	if err := json.Unmarshal(raw, &w); err != nil {
		return nil, 1
	}
	if w.Topic != "trade" {
		return nil, 1
	}
	for _, d := range w.Data {
		if d.P == "" || d.T <= 0 {
			dropped++
			continue
		}
		if _, err := strconv.ParseFloat(d.P, 64); err != nil {
			dropped++
			continue
		}
		ticks = append(ticks, Tick{
			Symbol: ToCanonical(w.Symbol), Price: d.P, Ts: d.T,
			Src: "trade", RecvMs: recvMs, TxID: d.V,
		})
	}
	return ticks, dropped
}

// ParseMark decodes one markPrice message into ticks.
func ParseMark(raw []byte, recvMs int64) (ticks []Tick, dropped int) {
	var w wireMark
	if err := json.Unmarshal(raw, &w); err != nil {
		return nil, 1
	}
	if w.Topic != "markPrice" {
		return nil, 1
	}
	for _, d := range w.Data {
		if d.MarkPrice == "" || d.Time <= 0 {
			dropped++
			continue
		}
		ticks = append(ticks, Tick{
			Symbol: ToCanonical(d.Symbol), Price: d.MarkPrice, Ts: d.Time,
			Src: "markPrice", RecvMs: recvMs,
		})
	}
	return ticks, dropped
}

// SanityReject flags jumps > 2% vs last without confirmation (T-04 poisoned data).
// Returns true when the tick must be held for multi-tick confirmation.
func SanityReject(lastPx, px string) (bool, error) {
	last, err1 := strconv.ParseFloat(lastPx, 64)
	cur, err2 := strconv.ParseFloat(px, 64)
	if err1 != nil || err2 != nil || last <= 0 {
		return false, fmt.Errorf("normalize: bad px pair")
	}
	jump := (cur - last) / last
	if jump < 0 {
		jump = -jump
	}
	return jump > 0.02, nil
}
