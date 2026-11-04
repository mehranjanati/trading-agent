# strategy-build: Build+register a strategy .wasm from a Go source dir
# (usage: make strategy-build SRC=path ID=sma-cross VERSION=0.3.0).
# The source dir must be a standalone module (own go.mod, stdlib-only main
# package) — never part of go-watcher/ itself, so AI output can't import the
# watcher (or wazero): the wasm guest is unprivileged by construction.
strategy-build: ## Build+register a strategy .wasm from a Go source dir (usage: make strategy-build SRC=path ID=sma-cross VERSION=0.3.0)
strategy-build:
	@test -n "$(SRC)" || (echo "usage: make strategy-build SRC=path/to/strategy ID=sma-cross VERSION=0.3.0" && exit 1)
	@test -n "$(ID)" || (echo "usage: make strategy-build SRC=path/to/strategy ID=sma-cross VERSION=0.3.0" && exit 1)
	@test -n "$(VERSION)" || (echo "usage: make strategy-build SRC=path/to/strategy ID=sma-cross VERSION=0.3.0" && exit 1)
	@command -v go >/dev/null || (echo "go toolchain required" && exit 1)
	@mkdir -p go-watcher/strategies/samples
	@cd "$(SRC)" && GOOS=wasip1 GOARCH=wasm CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o "$(CURDIR)/go-watcher/strategies/samples/$(ID)-$(VERSION).wasm" .
	@ls -la "go-watcher/strategies/samples/$(ID)-$(VERSION).wasm"
	@echo "add to go-watcher/strategies/samples/registry.json: {\"id\":\"$(ID)\",\"version\":\"$(VERSION)\",\"file\":\"$(ID)-$(VERSION).wasm\",\"configuration\":{}}"

.PHONY: check lint validate secrets test drills dev
check: lint validate secrets test
lint:
	@./scripts/check.sh
validate:
	@node scripts/validate-backlog.mjs
	@node scripts/migrate-check.mjs
	@node scripts/validate-strategy-contract.mjs
secrets:
	@./scripts/secret-scan.sh
test:
	@node --test workers/src/*.test.mjs scripts/chaos.test.mjs scripts/validate-strategy-contract.test.mjs scripts/paper-gate.test.mjs 2>&1 | tail -n 8
	@node --test dashboard/src/lib/*.test.mjs 2>&1 | tail -n 6
	@cd go-watcher && go test ./... 2>&1 | tail -n 8
# drills — SERVER-ONLY (E15/E16 infra split): the Go drills talk to the Redis that
# lives on the Go host (redisx defaults to 127.0.0.1:6379 and REDIS_URL points at the
# server instance). They are deliberately NOT part of `make check`/CI, which runs
# Redis-free tests only; run this on the Hetzner/Go host after deploying.
drills:
	@cd go-watcher && go run ./cmd/replay && go run ./cmd/flap | head -n 1 && go run ./cmd/restart-drill
dev:
	@echo "paper-mode dev stack (E00 skeleton — services land in E02..E05)"
