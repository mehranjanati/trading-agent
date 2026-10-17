// tg_endpoint.go — read API + metrics wiring for Telegram signals.
//
// Routes (advisory, read-only):
//   GET /api/tg/signals        ?bot=FalconToobitBot&n=20  → history (newest first)
//   GET /api/tg/signals:latest ?bot=FalconToobitBot       → latest signal
//
// The live listener is EITHER the standalone ./cmd/tg-userbot binary
// (-tags gotd) OR an embedded runner (also -tags gotd); both feed the same
// package-level sink + Redis keys, so these endpoints serve both modes.
// Without gotd the endpoints still answer from Redis (written by the
// standalone binary) — the watcher never requires MTProto linked in.
package main

import (
	"fmt"
	"net/http"
	"os"

	"trading-agent/go-watcher/tgsignals"
)

// tgSink is the process-shared fan-in. The embedded gotd runner (when built
// with -tags gotd) ingests into it; the read endpoints serve Redis either way.
var tgSink = tgsignals.NewSink()

var tgEndpoint = &tgsignals.Endpoint{Sink: tgSink}

func tgMetrics() string {
	return fmt.Sprintf("tg_accept=%d tg_dupes=%d tg_errors=%d\n",
		tgSink.Accept, tgSink.Dupes, tgSink.Errors)
}

// initTg starts the embedded userbot when TG_EMBED=1 and the binary was built
// with -tags gotd. Default is OFF: run ./cmd/tg-userbot separately so a
// Telegram reconnect storm can never share fate with the heartbeat plane.
// Implemented per build tag (tg_embed_gotd.go vs tg_embed_stub.go).
func initTg() {
	if os.Getenv("TG_EMBED") != "1" {
		return
	}
	startEmbeddedTg()
}

// mountTg registers the read routes.
func mountTg(mux *http.ServeMux) {
	mux.Handle("/api/tg/signals", tgEndpoint)
	mux.Handle("/api/tg/signals:latest", tgEndpoint)
}
