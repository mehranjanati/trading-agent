# Drills ledger — failover & recovery

Central register of executed failure drills. Playbook:
[../06-failover-and-recovery.md](../06-failover-and-recovery.md). Harness:
[`scripts/chaos.mjs`](../../scripts/chaos.mjs) (dry-run by default; every side
effect is guarded — see `guard()`). Evidence files are machine-written under
`docs/ops/drills/<task>/<drill>-<UTC>.json` and are **never hand-edited**.

## How to run (local)

Prerequisites: local Redis at `127.0.0.1:6379`, `node`, `go`, `sqlite3`.

```bash
# 1. Workers plane: the SAME worker entrypoint + the SAME runCron, over a
#    sqlite-backed D1 (wrangler dev cannot run on this macOS host).
node scripts/dev-server.mjs --port 8787 --db /tmp/e06.sqlite --cron-ms 10000
# 2. Go watcher against that plane (its cold start loads the ACTIVE set):
cd go-watcher && WORKERS_URL=http://127.0.0.1:8787 GO_PORT=8090 go run .
# 3. Run a drill (dry-run first, then --execute):
node scripts/chaos.mjs go   --execute --target local --db /tmp/e06.sqlite --go-pattern '[g]o-watcher'
node scripts/chaos.mjs redis --execute --target local --db /tmp/e06.sqlite --pause-ms 30000
node scripts/chaos.mjs both --execute --target local --db /tmp/e06.sqlite --go-pattern '[g]o-watcher' --pause-ms 30000
```

`--go-pattern` must match only the Go child. `go run` executes from the
build cache (`…/Caches/go-build/…/go-watcher`), so pass the `[g]o-watcher`
character-class form: it matches the binary but not the drill's own argv
(a plain `go-watcher` self-matches and the drill would `SIGSTOP` itself).

Give each drill a **fresh seeded DB** (migrations + ACTIVE watches + a healthy
PRIMARY baseline). The reconcile sweep certifies `reconcile.complete` once per
episode and only re-certifies after a sweep sees a non-empty inventory, so on a
reused DB a second drill cannot emit its own certify and `rejoin_order` would
pair against a stale incident.

The seeded watches are **drill fixtures** (`created_by=e06-drill`, ids
`w-drill-1..3`); the harness logs them as `DRILL DATA` on boot, the dashboard
watches table carries a `by` column, and `--no-seed` (or a fresh `--db`) gives a
clean desk. Nothing else in the local DB is synthetic.

### The trigger loop (stalk → trigger → analysis)

The Go watcher evaluates the ACTIVE set against live ticks and posts each edge to
the Worker. Start it against the local plane (the Stalk click already publishes
the watch as `ACTIVE`):

```bash
# 1. Workers plane, with the go-agent token both sides share
GO_AGENT_TOKEN=dev-token GO_WATCHER_URL=http://127.0.0.1:8090 \
  node scripts/dev-server.mjs --port 8787 --db /tmp/loop.sqlite --no-seed --cron-ms 300000

# 2. Watcher: cold start loads the ACTIVE set, the loop evaluates it
cd go-watcher && WORKERS_URL=http://127.0.0.1:8787 GO_AGENT_TOKEN=dev-token \
  TRIGGER_FEED=rest GO_PORT=8090 go run .

# 3. Stalk a zone whose trigger is already satisfied → the loop fires on the next tick
curl -s -X POST http://127.0.0.1:8787/api/watches -H 'content-type: application/json' -H 'x-role: trader' \
  -d '{"symbol":"BTCUSDT","direction":"LONG","trigger":{"op":">=","price":"1"},"invalidation":{"op":"<=","price":"0.5"}}'

# 4. Watch it move, and read the real run the engine produced
sqlite3 /tmp/loop.sqlite "SELECT id,status,version FROM watches;"
sqlite3 /tmp/loop.sqlite "SELECT from_s||' -> '||to_s||' ['||reason||']' FROM watch_transitions;"
sqlite3 /tmp/loop.sqlite "SELECT model,confidence,output_json FROM analysis_runs;"
curl -s http://127.0.0.1:8090/metrics | tail -1   # evals / fires / fire_errors
```

`TRIGGER_FEED=ws` swaps the REST poll for the production socket feed (conn
builders + reconnect + Redis `px:{sym}` publish). Without Redis the cold start
logs a connection error and readiness stays 503 — the trigger loop itself is
independent of Redis and does not gate readiness.

### Paper cycle needs the live engine

`node scripts/paper-cycle.mjs` drives a full cycle, and its step 5
(`POST /api/analysis:runs`) is computed by the real Go engine — the run row is
never fabricated. Start the watcher and point the dev server at it:

```bash
cd go-watcher && WORKERS_URL=http://127.0.0.1:8787 GO_PORT=8090 go run .
# dev server (other shell), same process env:
GO_WATCHER_URL=http://127.0.0.1:8090 node scripts/dev-server.mjs --port 8787 --db /tmp/paper.sqlite
```

Without `GO_WATCHER_URL` the route answers `503 DEGRADED` and writes nothing, so
the cycle stops at step 5 with an explicit hint instead of proceeding on an
invented analysis.

## Runs

### E06-T02 — S2 kill drills (local, 2026-10-12)

| Drill | Evidence | Result | Recovery | Path |
|---|---|---|---|---|
| kill-Go | `drills/E06-T02/go-2026-10-12T09-04-32-985Z.json` | PASS | 60s | PRIMARY → DEGRADED → PRIMARY |
| kill-Redis | `drills/E06-T02/redis-2026-10-12T09-19-50-812Z.json` | PASS | 66s | PRIMARY → DEGRADED → PRIMARY |
| kill-both + rejoin | `drills/E06-T02/both-2026-10-12T09-23-13-071Z.json` | PASS | 66s | PRIMARY → DEGRADED → FALLBACK → DEGRADED → PRIMARY |

Every run asserts: degradation observed; zero duplicate intents per approval;
all seven health components snapshotted; the ACTIVE set equals D1 truth in both
directions; the `reconcile.complete` incident precedes the return-to-PRIMARY
row; the lease handoff is recorded with a monotonic epoch; no
`rate_limit_backoff`; and (Go-killing drills) a paper approval is rejected while
degraded. Details and per-task notes: `drills/<task>/README.md`.

### E06-T02 — S3c budget proof

`drills/E06-T02/budget-*.json` (stub, N=10/N=100) and `budget-live-*.json`
(live read-only price endpoint): zero 429, peak within the 3000/min window.

## Findings & environment notes

- **`CLIENT UNPAUSE` from a paused socket (macOS/Redis 6.2.5).** The harness's
  own `UNPAUSE` times out because its connection was established before the
  pause; the pause's `--pause-ms` auto-expiry restores Redis instead. Pin
  `--pause-ms` so expiry lands **within** `--recover-ms` (30s works for a 130s
  recovery budget). A fresh connection *can* `CLIENT UNPAUSE` immediately, so
  this is a harness-socket artefact, not a defect in the system under test.
- **Return to PRIMARY needs the operator handoff** (`POST /api/lease:handoff`)
  until the `ExecutionAuthority` DO lands at E12 — nothing renews a lease that
  was never handed off.
- **Detection latency ≤ ~25s**: the §6.1 rule stays 15s (3 missed 5s beats) and
  the cron fires every 10s, so the observed detection lands ≤ ~25s after the
  last beat. Recorded, not compensated by weakening the rule.

## Deferrals (recorded, not silent)

- **Live 429-free run → Hetzner at E12** (this host's egress/soak story;
  attaches to the E11 gate report).
- **Real DO lease handoff → E12** (no DO binding yet; proven at module level).
- **5s fallback cadence → E12** (10s cron today; slower than the proven
  envelope, never faster).
- **Exchange-side ack-loss (§6.4) → E09** (E06-T02 proves *our* side is
  duplicate-free: intent rows, `evt` dedupe, approval single-use).
