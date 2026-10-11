# PLAN — E06-T02: Failover drills + rejoin

> Execution plan for task `E06-T02` (epic E06 · P0 · risk high · XL) from
> [BACKLOG.json](./BACKLOG.json). Playbooks:
> [../06-failover-and-recovery.md](../06-failover-and-recovery.md) · budget math:
> [../decisions/ADR-004-market-data-fallback.md](../decisions/ADR-004-market-data-fallback.md) ·
> exit gate: [./TEST-AND-RELEASE-GATES.md](./TEST-AND-RELEASE-GATES.md) (E06 row).
> Status flow: PROPOSED → READY → IN_PROGRESS → IN_REVIEW → DONE. Dependency
> E06-T01 is DONE. Written 2026-10-11.

## 1. Task frame (from BACKLOG.json)

- **Objective:** zero-dup recovery proof. **Scope:** REST poll in budget, handoff,
  reconcile sweep, checklist, `chaos.mjs`. **Out of scope:** no live orders
  (paper only; `LIVE_TRADING_ENABLED` must not exist — human release gate).
- **Acceptance criteria:** (1) Given Go+Redis dead When drilled Then restore +
  zero dup intents. (2) Given rejoin When returning Then non-terminals
  reconciled pre-PRIMARY.
- **Test plan:** injection suite + no-429 poll test. **E06 exit gate:**
  kill-Go/Redis/both drills + 429-free polls; evidence = drill logs + incidents.
- **Model routing:** author GLM-5.3 / reviewer Qwen3.8 Max (author ≠ reviewer on
  E06); record `author-model / reviewer-model / date` in the safety PR
  ([./MODEL-ASSIGNMENTS.md](./MODEL-ASSIGNMENTS.md)).
- **Affected components:** `workers`, `go-watcher`, `redis` (drills only — no
  Redis schema changes; **no new D1 migrations**: fixed-id rows in
  `health_snapshots` + the existing `order_intents` table suffice).

## 2. Environment constraints (recorded up front, not discovered mid-drill)

1. **No egress** to `api.toobit.com` / `stream.toobit.com` from this machine
   (E02-T02, `go-watcher/SOAK-NOTE.md`). The no-429 proof therefore runs against
   a **local stub exchange** implementing Toobit weight accounting
   (REQUEST_WEIGHT 3000/min = 50/s; poll endpoint weight 1; 429 +
   `X-Api-Limit-Reset-Timestamp` on breach). The live 429-free run is deferred
   to Hetzner at E12 deploy — same pattern as the soak deferral.
2. **No DO binding yet** — `workers/wrangler.toml` carries only D1 + cron;
   E05-T02 lease/DO is logic-tested (`do.test.mjs`). Lease handoff + fencing
   are proven at module level here; deployed-DO handoff lands with E12.
3. **Cron granularity 10 s vs 15 s heartbeat threshold** (§6.1: UNHEALTHY after
   3 missed 5 s beats). The rule stays 15 s (`health.mjs` `TH`); observed
   detection with a 10 s cron lands ≤ ~25 s after the last beat. Documented in
   the drill note — no threshold change.
4. **Drills need a local Redis** at 127.0.0.1:6379 (already required by
   `go run ./cmd/restart-drill` in `make test`).

## 3. Seam analysis — exists today vs what E06-T02 must build

| # | Seam that exists today | Gap E06-T02 closes |
|---|---|---|
| G1 | `workers/src/index.mjs` `scheduled()` hardcodes `go_heartbeat_ms: 0` ("Signals assembled … in E06-T02; here the seam") | real cron signals: heartbeat, stream lag, fallback flag, `healthy_contig_ms` |
| G2 | `go-watcher/main.go`: snapshot fetch is a "pending" stub; `ready` never set → `/readyz` always 503 | wire `snapshot.Fetch` cold start → repopulate ACTIVE set → `ready=true`; drop ready on Redis loss |
| G3 | no heartbeat publisher anywhere (§6.1 `hb:go`, 5 s cadence) | Go publishes liveness + `stream_lag_ms` + `redis_reachable` every 5 s |
| G4 | `health.mjs` `canReturnToPrimary` checks `reconciled` / `drained` / `lease_handoff` — nothing produces those states | reconcile sweep (§6.5) + drain counter + lease-handoff step |
| G5 | no fallback REST poller (ADR-004 decision) | budgeted poller + no-429 proof |
| G6 | no chaos/injection harness | `scripts/chaos.mjs` (S1) |
| G7 | `healthy_contig_ms` input of `canReturnToPrimary` is computed by nobody | cron derives it from the last non-PRIMARY mode row |

Existing assets reused, not rebuilt: `health.mjs` evaluator +
`canReturnToPrimary` + `badge`; `health-route.mjs` `tick` / `recordIncident`
(writes per-component `health_snapshots` rows + the `component='mode'` row +
`recovery_log` incidents); `lease.mjs` epoch fencing; the `restart-drill`
stdlib RESP client + stub-server pattern; the `replay` golden dedupe proof;
the `flap` backoff drill; D1 tables `order_intents` / `health_snapshots` /
`recovery_log` (`migrations/0002_schema.sql`).

## 4. W0 — seam wiring (prerequisite work package, lands first)

**W0.1 Go side (`go-watcher`)**
- Extract the RESP helper from `cmd/restart-drill/redis.go` into a shared
  package `go-watcher/redisx` (stdlib-only). `restart-drill` switches to it
  with identical behavior — it must stay green in `make test`.
- `main.go`: 5 s ticker → read stream lag from Redis (`XINFO STREAM` /
  last-append age; `redis_reachable=false` and lag −1 when unreachable) →
  `POST {go_heartbeat_ms, stream_lag_ms, redis_reachable}` to the Workers
  `POST /api/health:heartbeat` route (stdlib HTTP).
- Cold start: `snapshot.Fetch(WORKERS_URL)` → repopulate the ACTIVE set
  (`SADD watch:active-ids`, exactly as `restart-drill` does) →
  `ready.Store(true)`. Redis unreachable or fetch failure → `/readyz` 503
  with reason (§6.2 S2 semantics). Tests: stub Workers server + fake clock
  (the `cmd/restart-drill` pattern).

**W0.2 Workers side**
- New route `POST /api/health:heartbeat` (`health-route.mjs`): **upsert** a
  single `health_snapshots` row with fixed `id='hb_go'`, `component='hb_go'`,
  `detail_json` = payload (upsert, not append — no table growth). Why D1 and
  not a Redis `hb:go` key: the Workers plane has no Redis binding; D1 is the
  only store both planes reach. §6.1 semantics (5 s cadence, 15 s threshold)
  are unchanged.
- `index.mjs scheduled()`: assemble real signals — `go_heartbeat_ms` /
  `stream_lag_ms` / `redis_reachable` from the `hb_go` row;
  `fallback_active` = previous mode ≠ PRIMARY while Go is unhealthy
  (DEGRADED on first breach, FALLBACK once the fallback path is engaged);
  `healthy_contig_ms` = now − timestamp of the last mode change to
  non-PRIMARY while currently healthy (G7). `lease_expires_ms` /
  `lease_holder` stay null until the DO binding lands (E12) — `evaluate`
  already treats a null lease as held.
- Tests: heartbeat upsert + signal assembly against the sqlite-backed fake
  DB (existing `workers/src/*.test.mjs` pattern).

## 5. S1 — `scripts/chaos.mjs` (Node, stdlib-only) + injection suite

**Files:** `scripts/chaos.mjs`, `scripts/chaos.test.mjs`; the `Makefile`
`test` target is extended to
`node --test workers/src/*.test.mjs scripts/*.test.mjs` so the harness runs
inside `make check`.

**CLI:**

```
node scripts/chaos.mjs <go|redis|both|rejoin|budget> \
  [--phase preflight|kill|watch|restore|assert|all] [--target local] \
  [--execute] [--hard] [--json]
```

**Safety rails (S1 acceptance: "Given dry-run When run Then no prod touched"):**
- Default is **dry-run**: prints the planned actions, touches nothing, exit 0.
- `--execute` is required for any action; refuses unless `--target local` AND
  every address resolves to 127.0.0.1/localhost. The Go PID comes from
  `pgrep -f trading-agent/go-watcher` (never a broad pattern); Redis is paused
  via RESP `CLIENT PAUSE`, never `pkill`.
- Never mutates orders/approvals; the only order-related call is the
  *blocked-approval probe*, which asserts a rejection.
- Refuses if `ENV != dev` (wrangler vars) or if `LIVE_TRADING_ENABLED` exists
  anywhere in the environment (it must not exist — human release gate).

**Kill/pause modes:**
- `go`: SIGSTOP the go-watcher PID (heartbeat stops, process survives — the
  cleanest Go-loss). `--hard`: SIGKILL + relaunch `go run .` → exercises the
  §6.6 cold-start restart path.
- `redis`: RESP `CLIENT PAUSE <ms> ALL` (the server stops answering = real
  client-visible loss, reversible, no data loss). Fallback: SIGSTOP
  redis-server. Never FLUSHALL/SHUTDOWN inside drills.
- `both`: the two combined.

**Injection suite (test-plan item 1):** upsert the `hb_go` row (or POST the
route) with arbitrary `at` / payload → drives UNHEALTHY, LAG, D1_DOWN and the
60 s recovery window deterministically without wall-clock waits; plus
`fallback_active` and `d1_down` toggles. The pure parts (plan builder, safety
guards, assert functions over fixture rows) are unit-tested in
`chaos.test.mjs` — no live processes in unit tests.

**Assert mode (exit ≠ 0 on any failure; writes a JSON evidence file):**
1. Mode timeline via `GET /api/health` + `GET /api/recovery/log`: expected
   transitions (PRIMARY → DEGRADED/FALLBACK → PRIMARY) with matching incident
   rows (`mode:DEGRADED`, `health.recovered`).
2. Rows complete: `health_snapshots` has rows for every component (go, redis,
   d1, lease, prices, kill_switch, mode) across the drill window (S2
   acceptance).
3. Zero dup intents:
   `SELECT approval_id, COUNT(*) c FROM order_intents GROUP BY approval_id HAVING c>1`
   → empty; §6.6 evt dedupe — replaying already-recorded trigger fixtures
   emits no new `evt_` IDs (reuse the `replay` golden dedupe keys).
4. Watch-set equality: the ACTIVE set after restore == D1 snapshot truth
   (snapshot endpoint + RESP `SMEMBERS`).
5. Rejoin order: the `component='mode'` row flips to PRIMARY **only after**
   the reconcile-complete `recovery_log` row (timestamp ordering —
   acceptance criterion 2).
6. Counts: watches / intents / incidents / snapshots in the evidence JSON.

**Evidence:** `docs/ops/drills/E06-T02/<drill>-<UTC>.json` + a human summary;
ledger appended to `docs/ops/DRILLS.md` (new). This is the "drill logs +
incidents" evidence the E06 gate requires.
## 6. S2 — the 3 kill drills (§6.2 playbooks S1/S2/S3)

Shared runner: `node scripts/chaos.mjs <drill> --phase all --execute --target local`.
Preflight seeds a **paper-only fixture**: 10 ACTIVE watches in D1 (seed shape
from `migrations/0003_seed.sql`), a few non-terminal `order_intents`
(SUBMITTED / SUBMIT_UNKNOWN / ACKED / PARTIAL), and one already-recorded
trigger event.

**Drill 1 — Go loss (§6.2 S1)**
1. Preflight baseline: mode PRIMARY, fresh heartbeat, watch/intent/evt counts.
2. SIGSTOP go-watcher → heartbeat stops.
3. Cron: DEGRADED (`go_unhealthy`) + incident row; next tick
   `fallback_active` → FALLBACK. Blocked-approval probe: a paper approval
   attempt must be rejected (orders default-blocked) — assert the rejection,
   never a real order.
4. Fallback path: ACTIVE watches loaded from D1 (snapshot route); REST poll
   within budget (the S3c poller).
5. Restore: SIGCONT; the `--hard` variant re-runs `go run .` → cold-start
   snapshot reload (§6.6 restart-without-loss).
6. Assert (all six checks) + evidence.

**Drill 2 — Redis loss (§6.2 S2)**
1. Preflight baseline.
2. `CLIENT PAUSE` Redis → the Go heartbeat carries `redis_reachable=false` /
   lag ∞ → cron: redis LAG → DEGRADED; Go `/readyz` drops to 503 (the W0.1
   ready logic).
3. Bounded buffer: 10 k cap counter + shed-with-gap-record (metrics counters
   + gap rows) — assert counters and rows.
4. Unpause → Go reloads the D1 snapshot, resumes from the last-acked stream
   ID; replay the same fixtures through the stream → duplicates deduped (no
   new evt IDs) — assert.
5. Assert + evidence.

**Drill 3 — both lost (§6.2 S3) — proves acceptance criterion 1**
1. Pause Go + Redis.
2. Cron: DEGRADED → FALLBACK with full reasons; the poller switches to the
   **minimal top-N-by-priority** REST-only watch set — assert poll set ⊆
   ACTIVE and size ≤ N cap.
3. New orders blocked while uncertain; banner reasons visible in
   `/api/health`.
4. Restore Redis then Go (the S1+S2 combined recovery path) → rejoin sequence
   (S3) → PRIMARY.
5. Assert + evidence: restore + **zero dup intents** end-to-end.

## 7. S3 — Rejoin + budget

**S3a — reconcile sweep (`workers/src/reconcile.mjs`, new)**
- Sweeps the §6.5 inventory: `order_intents` with status IN (SUBMITTED,
  SUBMIT_UNKNOWN, ACKED, PARTIAL) plus `orders` missing
  `exchange_order_id`. Paper-mode resolution via an injectable resolver seam
  (drills inject deterministic outcomes; the real exchange-truth poll is E09
  — §6.4 is explicitly out of scope here). Idempotent by intent id;
  transitions written through the existing timeline/outbox pattern (E04).
- Cadence: a `last-sweep-at` row (fixed id) → sweep when age ≥ 15 s, and on
  **every** tick while mode ≠ PRIMARY ("every 15 s + on every recovery",
  §6.5).
- Feeds `canReturnToPrimary`: `non_terminal_intents` = live sweep count;
  `drained` = poller in-flight = 0.
- Tests: resolves all non-terminal states; idempotent re-run; **never a second
  intent for the same approval** (§6.4 rule); PRIMARY flips only after
  reconcile (timestamp-order test).

**S3b — lease handoff + fencing (module level)**
- Rejoin sequence test (new `workers/src/rejoin.test.mjs`, against
  `lease.mjs` + `health.mjs` with in-memory storage — the E05-T02
  `do.test.mjs` pattern): fallback holder holds the lease (epoch E) →
  recovery: reconciled + drained → release → primary re-acquires (epoch E+1)
  → a stale submit with epoch E → `verify` → `{ok:false, reason:"fenced"}`
  (the `lease.fenced` event) → `lease_ours=true` → `canReturnToPrimary().ok`
  → mode PRIMARY + `health.recovered` incident.
- The deployed-DO handoff is deferred to E12 (no DO binding in
  `wrangler.toml` yet) — recorded in the drill note.

**S3c — fallback REST poller + no-429 proof (`workers/src/fallback-poll.mjs`, new)**
- Token bucket (50/s sustained / 3000/min window) + jitter; batched
  `GET /quote/v1/contract/ticker/price` (weight 1); symbol set = ACTIVE
  watches (top-N by priority in the both-lost drill); enforces
  `min_poll_interval ≥ symbols × 1/50 × 2` (ADR-004). On 429 /
  `X-Api-Limit-Reset-Timestamp` → backoff + a `rate_limit_backoff` incident
  (ADR: alert if this ever fires).
- Cadence: ADR-004 chooses a 5 s poll; the cron is 10 s → the cron invokes
  the poller twice per tick (0 s / 5 s offsets, budget-guarded). The poller
  exposes a pure `tick(now)` so tests drive an exact 5 s cadence. The
  production DO-alarm cadence lands with E12 — noted in the drill note.
- **No-429 poll test** (`workers/src/fallback-poll.test.mjs`): a local stub
  Toobit server (`node:http`, the restart-drill stub pattern) with weight
  accounting (weight 1/request, 3000/min rolling window, 429 + reset header
  on breach). Drive N=10 (floor 0.4 s → 5 s cadence, 12× margin) and N=100
  (floor 4 s → 5 s cadence) for ≥ 5 simulated minutes: zero 429s, usage ≤
  budget, cadence ≥ floor. Negative test: shrink the stub budget → forced
  429 → incident row written (proves the alert path).
- **Live run deferred** (no egress): recorded in the drill note; executed on
  Hetzner at E12 and attached to the E11 gate report (SOAK-NOTE pattern).
- **`chaos.mjs budget` mode** runs the same load against the stub end-to-end
  and emits the evidence JSON for the gate.
- **Rejoin+budget drill** (`chaos.mjs rejoin`, folded into drill 3): with
  polling active, kill Go+Redis → restore → assert rejoin order (reconcile
  pre-PRIMARY), zero 429s across the fallback window (stub counters), zero
  dup intents. Closes both acceptance criteria end-to-end.
## 8. Execution order (small reviewable commits) + file map

| # | Commit | Content |
|---|---|---|
| 0 | `E06-T02: READY` | BACKLOG.json status PROPOSED → READY (deps met: E06-T01 DONE) |
| 1 | `E06-T02: seam wiring` | W0.1 + W0.2 (redisx, heartbeat publisher + route, real cron signals, Go ready/snapshot) — Go + workers tests |
| 2 | `E06-T02: chaos.mjs + injection suite` | S1 (+ Makefile test-target extension) |
| 3 | `E06-T02: reconcile sweep + rejoin/fencing tests` | S3a + S3b (before the drills that assert them) |
| 4 | `E06-T02: fallback poller + no-429 proof` | S3c (+ stub server, deferral note) |
| 5 | `E06-T02: 3 kill drills executed` | S2 — evidence JSON + logs + the DRILLS.md ledger |
| 6 | `E06-T02: DONE + gate evidence` | checklist close, EPICS.md E06 row, status IN_REVIEW → DONE |

Rationale: harness (S1) before drills (S2); sweep/poller code (S3) before the
drills that assert them; drills last — they are the evidence, not the code.

**File map:** `go-watcher`: `redisx/` (new), `main.go`,
`cmd/restart-drill/*` (switch to redisx), new tests. `workers/src`:
`health-route.mjs` (heartbeat route), `index.mjs` (signals), `reconcile.mjs`
(new), `fallback-poll.mjs` (new), `rejoin.test.mjs` / `reconcile.test.mjs` /
`fallback-poll.test.mjs` (new), extended health/index tests. `scripts`:
`chaos.mjs`, `chaos.test.mjs` (new). Root: `Makefile` (test target). Docs:
`docs/ops/DRILLS.md`, `docs/ops/drills/E06-T02/*`, `docs/tasks/BACKLOG.json`,
`docs/tasks/EPICS.md`, drill note. Migrations: none.

## 9. Verification matrix (acceptance → evidence)

| Acceptance / gate | Proof | Where |
|---|---|---|
| AC1 Go+Redis dead → restore + zero dup intents | Drill 3 evidence: dup-intent SQL empty + evt dedupe + watch-set equality | `docs/ops/drills/E06-T02/both-*.json` |
| AC2 rejoin → non-terminals reconciled pre-PRIMARY | timestamp-order assert (mode row vs reconcile incident) + reconcile tests | drill asserts + workers tests |
| S1 dry-run touches nothing | chaos.test guard cases + dry-run output | `scripts/chaos.test.mjs` |
| S2 rows complete | per-component snapshot coverage check | drill asserts |
| No-429 polls (ADR-004) | stub-server budget test N=10/N=100, zero 429, backoff-alert negative test | `workers/src/fallback-poll.test.mjs` |
| Injection suite | deterministic signal-injection tests | `scripts/chaos.test.mjs` |
| Repo gates | `make check` green (lint + validate-backlog + migrate-check + secret-scan + node --test + go test + replay + flap + restart-drill) | CI log |

## 10. DoD checklist (the "checklist" in scope)

- [ ] W0 seams wired (heartbeat publisher/route, real cron signals,
      `healthy_contig_ms`, Go ready/snapshot, redisx extraction)
- [ ] S1 chaos.mjs + safety guards + injection suite + Makefile extension
- [ ] S2 drills 1/2/3 executed; evidence JSON + logs committed
- [ ] S3a reconcile sweep + tests; S3b rejoin/fencing sequence test;
      S3c poller + no-429 test + deferral note
- [ ] Docs: `docs/ops/DRILLS.md` ledger + drill note (deferrals: live 429
      run → E12; DO handoff → E12; detection-latency note)
- [ ] BACKLOG.json status flips with evidence; EPICS.md E06 row updated
- [ ] `make check` green end-to-end
- [ ] Safety PR records `GLM-5.3 / Qwen3.8 Max / <date>` (author ≠ reviewer)

## 11. Risks & open notes

- `CLIENT PAUSE ALL` needs Redis ≥ 2.9 (the local 6.2.5 is fine); the SIGSTOP
  fallback is documented in `chaos.mjs --help`.
- 10 s cron vs 15 s threshold → observed detection ≤ ~25 s (rule unchanged,
  noted in the drill log).
- Lease handoff is proven at module level only until the DO binding lands
  (E12).
- The live 429-free run + live heartbeat cadence check are deferred to
  Hetzner/E12 (no egress here) and attach to the E11 gate report.
- Zero-dup scope is our side only (intent rows + evt dedupe); exchange-side
  ack-loss handling (§6.4) is E09 — E06-T02 proves no duplicate
  intents/events on our side, not exchange truth.
