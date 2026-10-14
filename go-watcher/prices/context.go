// Context assembly: what the model is told about the market each turn.
//
// The snapshot renders into an EPHEMERAL system turn prepended to the
// outbound window only — it is never appended to the session store. Prices
// are per-turn facts; persisting them would let a later turn quote a stale
// number as history.
package prices

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// maxSymbols caps the snapshot universe: one REST fallback round is
// sequential, so an unbounded parse of a symbol-stuffed message must not turn
// a chat turn into a rate-limit incident.
const maxSymbols = 8

// usdtToken matches "BTCUSDT"-shaped tokens in user text (any case).
var usdtToken = regexp.MustCompile(`(?i)\b([a-z]{2,12}usdt)\b`)

// bareAlias maps common short names / aliases found in chat to a canonical
// symbol stem. Deliberately small: anything unrecognized is simply not
// requested (the defaults still cover the majors).
var bareAlias = map[string]string{
	"btc": "BTC", "bitcoin": "BTC",
	"eth": "ETH", "ethereum": "ETH",
	"sol": "SOL", "solana": "SOL",
	"xrp": "XRP", "ripple": "XRP",
	"bnb": "BNB", "doge": "DOGE", "dogecoin": "DOGE",
	"avax": "AVAX", "avalanche": "AVAX",
	"link": "LINK", "ada": "ADA", "cardano": "ADA",
}

// bareWord matches alias candidates as standalone words.
var bareWord = regexp.MustCompile(`(?i)\b([a-z]{3,10})\b`)

// ExtractSymbols picks the snapshot universe for one turn: the default
// majors plus every recognizable symbol token in the given texts (usually
// just the newest user turn). Deduped, canonicalized, sorted, capped.
func ExtractSymbols(texts ...string) []string {
	set := map[string]bool{}
	for _, d := range DefaultSymbols() {
		set[d] = true
	}
	for _, t := range texts {
		for _, m := range usdtToken.FindAllStringSubmatch(t, -1) {
			set[strings.ToUpper(m[1])] = true
		}
		for _, m := range bareWord.FindAllStringSubmatch(t, -1) {
			if stem, ok := bareAlias[strings.ToLower(m[1])]; ok {
				set[stem+"USDT"] = true
			}
		}
	}
	out := make([]string, 0, len(set))
	for s := range set {
		out = append(out, s)
	}
	sort.Strings(out)
	if len(out) > maxSymbols {
		out = out[:maxSymbols]
	}
	return out
}

// SystemMessage renders the snapshot as the system turn content. Returns ""
// only if there is nothing truthful to say (never happens today — an empty
// snapshot still renders the "unavailable" line, which is the point).
func SystemMessage(snap Snapshot) string {
	var b strings.Builder
	b.WriteString("LIVE MARKET CONTEXT (injected by the platform this turn; it is your ONLY permitted price source):\n")
	at := snap.At
	for _, p := range snap.Prices {
		age := p.AgeMs
		label := "LIVE"
		if p.Stale {
			label = "STALE"
		} else if age > 5000 {
			label = "RECENT"
		}
		fmt.Fprintf(&b, "- %s: %s  [%s, src=%s, age=%dms, asof_ms=%d]\n", p.Symbol, p.Px, label, p.Src, age, p.Ts)
	}
	for _, m := range snap.Missing {
		fmt.Fprintf(&b, "- %s: UNAVAILABLE (no source answered — do NOT guess a price from memory)\n", m)
	}
	if !snap.Has() {
		b.WriteString("No symbol could be fetched this turn. Say market data is unavailable instead of quoting remembered prices.\n")
	}
	fmt.Fprintf(&b, "Snapshot taken at asof=%d (unix ms). Quote these numbers with their age; never invent others.", at)
	return b.String()
}

// FetchAndRender is the convenience seam for callers that just want the
// system text: extract symbols from the turn texts, fetch, render.
func FetchAndRender(ctx context.Context, texts ...string) string {
	return SystemMessage(Fetch(ctx, ExtractSymbols(texts...)))
}
