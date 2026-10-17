//go:build !gotd

package main

import (
	"fmt"
	"os"
)

// startEmbeddedTg without the gotd tag: TG_EMBED=1 is a no-op with a hint.
// Run the standalone listener: go run -tags gotd ./cmd/tg-userbot.
func startEmbeddedTg() {
	fmt.Fprintln(os.Stderr, "tg: embedded needs -tags gotd; run ./cmd/tg-userbot instead")
}
