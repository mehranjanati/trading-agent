.PHONY: check lint validate secrets dev
check: lint validate secrets
	@echo "make check: OK"
lint:
	@./scripts/check.sh
validate:
	@python3 scripts/validate-backlog.py
secrets:
	@./scripts/secret-scan.sh
dev:
	@echo "paper-mode dev stack (E00 skeleton — services land in E02..E05)"
