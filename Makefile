.PHONY: check lint validate secrets test dev
check: lint validate secrets test
	@echo "make check: OK"
lint:
	@./scripts/check.sh
validate:
	@node scripts/validate-backlog.mjs
	@node scripts/migrate-check.mjs
secrets:
	@./scripts/secret-scan.sh
test:
	@node --test workers/src/*.test.mjs 2>&1 | tail -n 8
	@cd go-watcher && go test ./... 2>&1 | tail -n 8
	@cd go-watcher && go run ./cmd/replay && go run ./cmd/flap | head -n 1
dev:
	@echo "paper-mode dev stack (E00 skeleton — services land in E02..E05)"
