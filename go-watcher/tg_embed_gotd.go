//go:build gotd

package main

import (
	"context"
	"fmt"
	"os"
	"time"

	"trading-agent/go-watcher/tgsignals"
)

// startEmbeddedTg runs the MTProto listener inside the watcher process
// (TG_EMBED=1, -tags gotd). Backoff on disconnect; never gates readiness.
func startEmbeddedTg() {
	cfg, err := tgsignals.ConfigFromEnv()
	if err != nil {
		fmt.Fprintln(os.Stderr, "tg: embedded disabled:", err)
		return
	}
	go func() {
		backoff := 5 * time.Second
		for {
			err := tgsignals.Run(context.Background(), cfg, tgSink)
			fmt.Fprintln(os.Stderr, "tg: embedded disconnected:", err, "— retry in", backoff)
			time.Sleep(backoff)
			if backoff < 5*time.Minute {
				backoff *= 2
			}
		}
	}()
	fmt.Fprintln(os.Stderr, "tg: embedded userbot starting")
}
