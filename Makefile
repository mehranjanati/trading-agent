.PHONY: check lint validate secrets test dev
check: lint validate secrets test
	@echo "make check: OK"
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
	@cd go-watcher && go run ./cmd/replay && go run ./cmd/flap | head -n 1 && go run ./cmd/restart-drill
dev:
	@echo "paper-mode dev stack (E00 skeleton — services land in E02..E05)"
