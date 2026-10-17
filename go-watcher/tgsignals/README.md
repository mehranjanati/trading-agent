# Telegram signals (personal userbot via gotd/td)

Reads FalconToobitBot setups through YOUR OWN account (MTProto userbot).
Bot API can't read another bot's DMs — gotd/td is required.

## 1. Telegram app credentials (once)

1. https://my.telegram.org/apps → create app → note `api_id` + `api_hash`.
2. Export (never commit):

```sh
export TG_APP_ID=123456
export TG_APP_HASH=0123456789abcdef...
export TG_PHONE=+98912xxxxxxx        # first login only
export TG_CODE=12345                 # code Telegram sends, first login only
# export TG_PASSWORD=...             # only if the account has 2FA
export TG_ALLOW_BOTS=FalconToobitBot # comma-separated allow-list
export TG_SESSION_FILE=$HOME/.tg-session.json
```

## 2. Run the listener (standalone, recommended)

```sh
cd go-watcher
go run -tags gotd ./cmd/tg-userbot
```

First run logs in and writes the session file; later runs reuse it
(no code needed — unset TG_CODE after). Every setup from the allow-listed
bot is parsed and stored in Redis:

- `tg:signals:<bot>` — history list (newest first, cap 200)
- `tg:signal:latest:<bot>` — latest JSON
- `events:tg-signals` — live stream (MAXLEN ~10000)

Reconnects use 5s→5m backoff; a Telegram/Redis outage is logged, never
fabricates a signal, never gates /readyz.

## 3. Read API (on go-watcher, no tag needed)

- `GET /api/tg/signals?bot=FalconToobitBot&n=20` — history, newest first
- `GET /api/tg/signals:latest?bot=FalconToobitBot` — latest
- `/metrics` gains `tg_accept/tg_dupes/tg_errors`

Signal JSON: `symbol` (SPX-SWAP-USDT), `canonical` (SPXUSDT),
`exchange/timeframe/position/pivot/close_time/channel`, raw `text`.

## 4. Embedded mode (optional)

`TG_EMBED=1` + a `-tags gotd` watcher binary runs the listener in-process.
Default OFF — the standalone binary keeps Telegram reconnects off the
heartbeat plane.

## 5. Docker

The default image stays gotd-free (stdlib-only). For a gotd image:

```dockerfile
# builder: go build -tags gotd ./cmd/tg-userbot
```

Session file must be a mounted secret/volume, never baked in.
