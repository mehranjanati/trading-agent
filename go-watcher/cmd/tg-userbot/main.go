//go:build gotd

// Command tg-userbot — standalone Telegram userbot for signal ingestion.
//
// Reads TG_* env (see tgsignals.ConfigFromEnv), listens for Falcon bot
// messages, persists every setup to Redis. Run next to go-watcher:
//
//	TG_APP_ID=... TG_APP_HASH=... TG_PHONE=+98912... TG_CODE=12345 \
//	  go run -tags gotd ./cmd/tg-userbot
//
// First run logs in and writes tg-session.json; later runs reuse it.
// Advisory-only: a Telegram/Redis outage is logged with backoff, the
// process keeps retrying and never fabricates a signal.
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"time"

	"trading-agent/go-watcher/tgsignals"
)

func main() {
	cfg, err := tgsignals.ConfigFromEnv()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	sink := tgsignals.NewSink()
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()

	backoff := 5 * time.Second
	for {
		err := tgsignals.Run(ctx, cfg, sink)
		if ctx.Err() != nil {
			fmt.Fprintln(os.Stderr, "tg-userbot: closed")
			return
		}
		fmt.Fprintln(os.Stderr, "tg-userbot: disconnected:", err, "— retry in", backoff)
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff < 5*time.Minute {
			backoff *= 2
		}
	}
}
