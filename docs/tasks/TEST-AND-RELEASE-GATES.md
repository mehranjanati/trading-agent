# Test & Release Gates

## Per-epic gates
- E02: 24h WS soak, flap test. E03: replay determinism. E04: restart-safe. E06: kill-Go/Redis/both + split-brain. E08: all risk rejects covered. E09: ack-loss reconcile. E11: 14d paper, zero unapproved orders.

## Release gate (human)
No live-trading code enabled without: all P0 DONE + paper report + security review + signed approval in `recovery_log`. Default `LIVE_TRADING_ENABLED=false` (no such flag in MVP).
