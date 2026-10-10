# E02-T02 Soak Note (S3)

- **Flap drill:** `go run ./cmd/flap` → 10 drops → 20 clean resubscribes, PASS (backoff 1s→60s+jitter verified in-bounds).
- **Unit:** `go test ./...` green (conn 3 tests, normalize 5 tests); `gofmt` clean; `go vet` clean.
- **Live 24h soak:** DEFERRED — this environment has no route to `stream.toobit.com` (Go proxy TLS timeout confirms no egress). Run on Hetzner at E12 deploy: `go run . 2>soak.log` for 24h, attach log + `metrics.Render()` counters to the E11 gate report. Zero unhandled disconnects required.
- **WS client choice:** stdlib message builders now; real socket lands with `gorilla/websocket` (or `nhooyr`) once egress exists — interface seam is `conn.Subscribe/Ping/Backoff` (unchanged). CloudWeGo evaluated and rejected (no RPC/mesh need; see decision log 2026-10-10).
