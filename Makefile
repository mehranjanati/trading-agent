.PHONY: check lint validate secrets dev
check: lint validate secrets
	@echo "make check: OK"
lint:
	@./scripts/check.sh
validate:
	@node scripts/validate-backlog.mjs
secrets:
	@./scripts/secret-scan.sh
dev:
	@echo "paper-mode dev stack (E00 skeleton — services land in E02..E05)"
