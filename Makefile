# The strategy pipeline (the authoring loop). WHY THESE EXIST: `strategy-build`
# only proved a strategy COMPILES; nothing proved it SPEAKS the contract, and
# registry.json was hand-edited with no validation. These targets wrap the one
# entrypoint (scripts/strategy-pipeline.mjs) that builds, runs the real bytes
# through the real runner, and records provenance — locally and in CI alike.
#
#   make strategy-new ID=rsi-reversion          scaffold a standalone module
#   make strategy-check SRC=... ID=... VERSION=...   build + verify + manifest
#   make strategy-verify-all                     CI: verify every dev module
#   make strategy-register MANIFEST=... [ACTIVATE=1]  explicit human promotion
#   make lint-registry                           registry.json + artifact integrity
strategy-new: ## Scaffold a strategy module (usage: make strategy-new ID=rsi-reversion [NAME="RSI Reversion"])
	@test -n "$(ID)" || (echo "usage: make strategy-new ID=rsi-reversion [NAME=\"RSI Reversion\"]" && exit 1)
	@node scripts/strategy-new.mjs --id "$(ID)" $(if $(NAME),--name "$(NAME)")

strategy-check: ## Build + contract-verify + manifest (usage: make strategy-check SRC=strategies/dev/x ID=x VERSION=0.1.0)
	@test -n "$(SRC)" || (echo "usage: make strategy-check SRC=path/to/strategy ID=x VERSION=0.1.0" && exit 1)
	@test -n "$(ID)" || (echo "usage: make strategy-check SRC=path/to/strategy ID=x VERSION=0.1.0" && exit 1)
	@test -n "$(VERSION)" || (echo "usage: make strategy-check SRC=path/to/strategy ID=x VERSION=0.1.0" && exit 1)
	@node scripts/strategy-pipeline.mjs --src "$(SRC)" --id "$(ID)" --version "$(VERSION)"

strategy-verify-all: ## Build + contract-verify every module under strategies/dev (CI gate)
	@node scripts/strategy-verify-all.mjs

strategy-template-check: ## Prove the shipped template still satisfies the contract (CI invariant)
	@node scripts/strategy-pipeline.mjs --src go-watcher/strategies/template --id template-probe --version 0.0.1

strategy-register: ## Publish a verified artifact into the registry (dry run without ACTIVATE=1)
	@test -n "$(MANIFEST)" || (echo "usage: make strategy-register MANIFEST=go-watcher/strategies/build/x-0.1.0.manifest.json [ACTIVATE=1]" && exit 1)
	@node scripts/register-strategy.mjs --manifest "$(MANIFEST)" $(if $(ACTIVATE),--activate)

lint-registry: ## Validate registry.json + artifact integrity (sha256, ids, statuses)
	@node scripts/lint-registry.mjs

# strategy-build: Build a strategy .wasm from a Go source dir (the LOW-LEVEL
# copy step inside strategy-check; it verifies nothing — prefer strategy-check).
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

.PHONY: check lint validate secrets test drills dev vectorize-index strategy-new strategy-check strategy-verify-all strategy-template-check strategy-register lint-registry
check: lint validate secrets test
lint:
	@./scripts/check.sh
validate:
	@node scripts/validate-backlog.mjs
	@node scripts/migrate-check.mjs
	@node scripts/validate-strategy-contract.mjs
	@node scripts/lint-registry.mjs
secrets:
	@./scripts/secret-scan.sh
test:
	@node --test workers/src/*.test.mjs scripts/chaos.test.mjs scripts/validate-strategy-contract.test.mjs scripts/lint-registry.test.mjs scripts/paper-gate.test.mjs 2>&1 | tail -n 8
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

# vectorize-index — create the RAG Vectorize index (account-level, idempotent).
# Needed ONCE before uncommenting the [[vectorize]] binding in wrangler.toml;
# without the index `wrangler deploy` fails closed (code 10159).
vectorize-index: ## Create the RAG Vectorize index (rag-docs-index, 1024-dim, cosine)
	@./scripts/vectorize-index.sh
