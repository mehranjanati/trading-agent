# RBAC Matrix — E01-T02-S1 (route × role; enforced in E05-T01)

Roles: `trader` (watches, signals, approve own queue) · `operator` (deploys, kill-switch, drills) · `admin` (key rotation approvals, strategy activation). Separation of duties: approver ≠ risk-config editor on the same order path (SAFE-010).

| Route | trader | operator | admin | Notes |
|---|---|---|---|---|
| `POST /api/watches` | ✅ | ✅ | ✅ | creator recorded |
| `GET /api/watches*` | ✅ | ✅ | ✅ | |
| `POST /api/signals:ingest` | ❌ | ❌ | ❌ | **HMAC-authenticated webhook** (Q-07); role header is not the gate — a valid signature from an allowlisted source is |
| `POST /api/analysis:runs` | ✅ | ✅ | ✅ | advisory only |
| `POST /api/approvals` (grant/reject) | ✅ | ❌ | ✅ | trader grants; operator cannot self-approve ops |
| `POST /api/orders:intents` | ✅ | ❌ | ❌ | needs valid approval + risk PASS |
| `POST /api/kill-switch` | ❌ | ✅ engage | ✅ engage+release | release needs 2nd human confirm |
| `GET /api/health`, `/recovery/log` | ✅ | ✅ | ✅ | |
| Strategy activation (`POST /api/strategy:activate`) | ❌ | ❌ | ✅ | admin-only; versioned, audited (E07-T01) |
| Secret rotation approval | ❌ | request | ✅ approve | two-person rule |

Auth: OIDC/JWT Bearer; approval calls need step-up confirm (fresh token ≤5min). Envelopes: 401 unauthenticated, 403 unauthorized + `trace_id`. Every decision logs actor + IP + time.

Related: [Key policy](./TOOBIT-KEY-POLICY.md) · [Security §07](../07-security-and-threat-model.md).
