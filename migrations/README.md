# Migrations (D1, forward-only)

- Naming: `NNNN_description.sql`. E04-T01 authors real schema (watches, events, approvals, intents, orders, ...).
- Apply: `wrangler d1 migrations apply <db> --remote` per env. Never destructive down-migration.
