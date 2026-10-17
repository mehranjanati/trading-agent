//go:build gotd

// Runner — live MTProto listener (needs `-tags gotd`).
//
// WHY a build tag: gotd/td pulls a large dependency tree. The default
// watcher build stays stdlib-only; only `go build -tags gotd` (or the
// tg-userbot binary) links MTProto. The tgsignals parser/store/endpoint
// are the seam this runner feeds.
//
// Auth model (userbot, NOT Bot API):
//   - TG_APP_ID / TG_APP_HASH from https://my.telegram.org/apps.
//   - TG_PHONE (+98912..., international) for the first login.
//   - TG_CODE = login code Telegram sends on first run (env, headless).
//   - TG_PASSWORD = 2FA password if the account has one.
//   - TG_SESSION_FILE (default ./tg-session.json): persisted session,
//     later runs reuse it with no code.
//   - TG_ALLOW_BOTS (default FalconToobitBot): comma-separated bot
//     usernames whose incoming messages are ingested.
package tgsignals

import (
	"context"
	"os"
	"strconv"
	"strings"

	"github.com/go-faster/errors"
	"github.com/gotd/td/telegram/auth"
	"github.com/gotd/td/tg"
)

// Config is the runner's env-derived configuration.
type Config struct {
	AppID       int
	AppHash     string
	Phone       string
	Code        string
	Password    string
	SessionFile string
	AllowBots   []string
}

// ConfigFromEnv reads TG_* vars.
func ConfigFromEnv() (Config, error) {
	id, _ := strconv.Atoi(strings.TrimSpace(os.Getenv("TG_APP_ID")))
	hash := strings.TrimSpace(os.Getenv("TG_APP_HASH"))
	if id == 0 || hash == "" {
		return Config{}, errors.New("tgsignals: set TG_APP_ID/TG_APP_HASH from https://my.telegram.org/apps")
	}
	c := Config{
		AppID:       id,
		AppHash:     hash,
		Phone:       strings.TrimSpace(os.Getenv("TG_PHONE")),
		Code:        strings.TrimSpace(os.Getenv("TG_CODE")),
		Password:    strings.TrimSpace(os.Getenv("TG_PASSWORD")),
		SessionFile: strings.TrimSpace(os.Getenv("TG_SESSION_FILE")),
	}
	if c.SessionFile == "" {
		c.SessionFile = "tg-session.json"
	}
	allow := strings.TrimSpace(os.Getenv("TG_ALLOW_BOTS"))
	if allow == "" {
		allow = BotUsername
	}
	for _, b := range strings.Split(allow, ",") {
		if b = strings.TrimSpace(strings.TrimPrefix(b, "@")); b != "" {
			c.AllowBots = append(c.AllowBots, b)
		}
	}
	return c, nil
}

func (c Config) allowed(username string) bool {
	for _, b := range c.AllowBots {
		if strings.EqualFold(b, strings.TrimPrefix(username, "@")) {
			return true
		}
	}
	return false
}

// envAuth implements auth.UserAuthenticator from env (headless-friendly).
type envAuth struct {
	phone, code, password string
}

func (e envAuth) Phone(_ context.Context) (string, error) {
	if e.phone == "" {
		return "", errors.New("tgsignals: no session yet — set TG_PHONE and TG_CODE for first login")
	}
	return e.phone, nil
}
func (e envAuth) Password(_ context.Context) (string, error) { return e.password, nil }
func (e envAuth) Code(_ context.Context, _ *tg.AuthSentCode) (string, error) {
	if e.code == "" {
		return "", errors.New("tgsignals: login code required — set TG_CODE from Telegram")
	}
	return strings.TrimSpace(e.code), nil
}
func (envAuth) SignUp(_ context.Context) (auth.UserInfo, error) {
	return auth.UserInfo{}, errors.New("tgsignals: sign-up not supported")
}
func (envAuth) AcceptTermsOfService(_ context.Context, tos tg.HelpTermsOfService) error {
	return &auth.SignUpRequired{TermsOfService: tos}
}
