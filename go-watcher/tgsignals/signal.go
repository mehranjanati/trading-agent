// Package tgsignals — Telegram signal ingestion (stdlib-only core).
//
// WHY: the FalconToobitBot pushes trade setups (SPX-SWAP-USDT style messages)
// to the operator's personal Telegram. Bot API cannot read another bot's
// messages in a private chat — only a userbot (MTProto, gotd/td) logged in
// as the operator's own account can see them. This package is the stable
// core that does NOT depend on gotd:
//
//   - Signal: the parsed setup (symbol, exchange, timeframe, position/pivot
//     type, close-candle time, channel, raw text).
//   - Parse: turns the Falcon message text into a Signal. Never invents a
//     tick: unparseable text is an error, never a synthetic signal.
//   - Store: Redis persistence seam (LPUSH tg:signals:<bot> + LTRIM, plus
//     latest key tg:signal:latest:<bot>). Production impl talks RESP via
//     net.Conn like redisx; tests substitute a stub.
//
// The live MTProto listener lives behind the `gotd` build tag
// (runner_gotd.go + cmd/tg-userbot) so the default `go build ./...` stays
// stdlib-only and gotd's dependency tree never leaks into the watcher
// image unless explicitly enabled.
package tgsignals

import (
	"fmt"
	"regexp"
	"strings"
	"time"
)

// BotUsername is the default signal source (Falcon | Toobit bot).
const BotUsername = "FalconToobitBot"

// KeyPrefix namespaces every Redis key this package owns.
const KeyPrefix = "tg:signals:"

// LatestPrefix namespaces the latest-signal key per bot.
const LatestPrefix = "tg:signal:latest:"

// HistoryLen caps the per-bot Redis list (newest first).
const HistoryLen = 200

// Signal is one parsed Falcon setup message.
type Signal struct {
	Bot       string `json:"bot"`
	Symbol    string `json:"symbol"`     // SPX-SWAP-USDT (venue form, as sent)
	Canonical string `json:"canonical"`  // SPXUSDT (trigger-loop form)
	Exchange  string `json:"exchange"`   // ToobitFutures
	Category  string `json:"category"`   // Crypto
	Timeframe string `json:"timeframe"`  // FiveMinutes
	Position  string `json:"position"`   // Toobit Tiger
	Pivot     string `json:"pivot"`      // SuperMinor
	CloseTime string `json:"close_time"` // raw "10/18/2026 12:15:00 AM"
	CloseUnix int64  `json:"close_unix_ms,omitempty"`
	Channel   string `json:"channel"` // @atlas_mining
	Text      string `json:"text"`    // full raw message text
	MsgID     int    `json:"msg_id,omitempty"`
	Date      int64  `json:"date_unix,omitempty"`
	RecvAt    string `json:"recv_at"`
}

var (
	reSymbol    = regexp.MustCompile(`(?m)^([A-Z0-9]+-SWAP-USDT)\s*$`)
	reExchange  = regexp.MustCompile(`(?m)^Exchange:\s*(.+?)\s*$`)
	reCategory  = regexp.MustCompile(`(?m)^Category:\s*(.+?)\s*$`)
	reTimeframe = regexp.MustCompile(`(?m)^Timeframe:\s*(.+?)\s*$`)
	rePosition  = regexp.MustCompile(`(?m)^Position type\s*:\s*(.+?)\s*$`)
	rePivot     = regexp.MustCompile(`(?m)^Pivot type\s*:\s*(.+?)\s*$`)
	reClose     = regexp.MustCompile(`(?m)^Close candle Time:\s*(.+?)\s*$`)
	reChannel   = regexp.MustCompile(`(?m)^Channel\s*:\s*(@\S+)\s*$`)
)

// Parse turns a Falcon bot message into a Signal. It returns an error when
// the text is not a setup (disclaimer-only, media-only, other bots) so the
// caller stores nothing instead of a half-parsed row.
func Parse(bot, text string, msgID int, dateUnix int64, recv time.Time) (Signal, error) {
	if strings.TrimSpace(text) == "" {
		return Signal{}, fmt.Errorf("tgsignals: empty text")
	}
	m := reSymbol.FindStringSubmatch(text)
	if m == nil {
		return Signal{}, fmt.Errorf("tgsignals: not a setup (no SYMBOL-SWAP-USDT line)")
	}
	sym := strings.TrimSpace(m[1])
	s := Signal{
		Bot:      bot,
		Symbol:   sym,
		Canonical: toCanonical(sym),
		Exchange: first(reExchange, text),
		Category: first(reCategory, text),
		Timeframe: first(reTimeframe, text),
		Position: first(rePosition, text),
		Pivot:    first(rePivot, text),
		CloseTime: first(reClose, text),
		Channel:  first(reChannel, text),
		Text:     text,
		MsgID:    msgID,
		Date:     dateUnix,
		RecvAt:   recv.UTC().Format(time.RFC3339),
	}
	if s.Exchange == "" || s.Timeframe == "" {
		return Signal{}, fmt.Errorf("tgsignals: setup missing exchange/timeframe")
	}
	if s.CloseTime != "" {
		if t, err := parseCloseTime(s.CloseTime); err == nil {
			s.CloseUnix = t.UnixMilli()
		}
	}
	if bot == "" {
		s.Bot = BotUsername
	}
	return s, nil
}

func first(re *regexp.Regexp, text string) string {
	if m := re.FindStringSubmatch(text); m != nil {
		return strings.TrimSpace(m[1])
	}
	return ""
}

// toCanonical maps venue form BTC-SWAP-USDT -> BTCUSDT (the trigger-loop and
// prices form). Non-matching input passes through upper-cased.
func toCanonical(sym string) string {
	s := strings.ToUpper(strings.TrimSpace(sym))
	if strings.HasSuffix(s, "-SWAP-USDT") {
		return strings.TrimSuffix(s, "-SWAP-USDT") + "USDT"
	}
	return s
}

func parseCloseTime(raw string) (time.Time, error) {
	for _, layout := range []string{"1/2/2006 3:04:05 PM", "01/02/2006 15:04:05", time.RFC3339} {
		if t, err := time.Parse(layout, strings.TrimSpace(raw)); err == nil {
			return t, nil
		}
	}
	return time.Time{}, fmt.Errorf("tgsignals: bad close time %q", raw)
}

// ListKey is the Redis history list for a bot. StreamKey is the live fan-out
// stream the watcher XADDs every accepted signal to (events:tg-signals).
func ListKey(bot string) string   { return KeyPrefix + bot }
func LatestKey(bot string) string { return LatestPrefix + bot }

// StreamSignals is the Redis stream carrying live signal events.
const StreamSignals = "events:tg-signals"
