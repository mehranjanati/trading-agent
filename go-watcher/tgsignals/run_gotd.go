//go:build gotd

package tgsignals

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/go-faster/errors"
	"github.com/gotd/contrib/middleware/floodwait"
	"github.com/gotd/td/session"
	"github.com/gotd/td/telegram"
	"github.com/gotd/td/telegram/auth"
	"github.com/gotd/td/telegram/updates"
	updhook "github.com/gotd/td/telegram/updates/hook"
	"github.com/gotd/td/tg"
)

// Run connects the userbot and blocks until ctx is done. Every incoming
// message from an allow-listed bot is ingested into sink (parse → Redis).
// A dead Telegram connection is an error to the caller (backoff + retry in
// the binary) — never fatal to the watcher process itself.
func Run(ctx context.Context, cfg Config, sink *Sink) error {
	dispatcher := tg.NewUpdateDispatcher()
	mgr := updates.New(updates.Config{Handler: dispatcher})

	client := telegram.NewClient(cfg.AppID, cfg.AppHash, telegram.Options{
		SessionStorage: &session.FileStorage{Path: cfg.SessionFile},
		UpdateHandler:  mgr,
		Middlewares: []telegram.Middleware{
			floodwait.NewWaiter().WithCallback(func(_ context.Context, wait floodwait.FloodWait) {
				fmt.Fprintln(os.Stderr, "tgsignals: flood-wait", wait.Duration)
			}),
			updhook.UpdateHook(mgr.Handle),
		},
	})

	dispatcher.OnNewChannelMessage(func(ctx context.Context, e tg.Entities, u *tg.UpdateNewChannelMessage) error {
		msg, ok := u.Message.(*tg.Message)
		if !ok || msg.Out {
			return nil
		}
		return handleMsg(cfg, sink, e, msg)
	})
	dispatcher.OnNewMessage(func(ctx context.Context, e tg.Entities, u *tg.UpdateNewMessage) error {
		msg, ok := u.Message.(*tg.Message)
		if !ok || msg.Out {
			return nil
		}
		return handleMsg(cfg, sink, e, msg)
	})

	flow := auth.NewFlow(envAuth{phone: cfg.Phone, code: cfg.Code, password: cfg.Password}, auth.SendCodeOptions{})
	return client.Run(ctx, func(ctx context.Context) error {
		st, err := client.Auth().Status(ctx)
		if err != nil {
			return errors.Wrap(err, "auth status")
		}
		if !st.Authorized {
			if err := client.Auth().IfNecessary(ctx, flow); err != nil {
				return errors.Wrap(err, "auth")
			}
			fmt.Fprintln(os.Stderr, "tgsignals: logged in, session saved to", cfg.SessionFile)
		} else {
			fmt.Fprintln(os.Stderr, "tgsignals: reusing stored session")
		}
		self, err := client.Self(ctx)
		if err != nil {
			return errors.Wrap(err, "self")
		}
		fmt.Fprintln(os.Stderr, "tgsignals: listening as", self.Username, "allow=", strings.Join(cfg.AllowBots, ","))
		return mgr.Run(ctx, client.API(), self.ID, updates.AuthOptions{IsBot: self.Bot})
	})
}

func handleMsg(cfg Config, sink *Sink, e tg.Entities, msg *tg.Message) error {
	if strings.TrimSpace(msg.Message) == "" {
		return nil // media-only — caption-less chart images carry no setup
	}
	var username string
	if from, ok := msg.FromID.(*tg.PeerUser); ok {
		if u, ok := e.Users[from.UserID]; ok && u.Bot {
			username = u.Username
		} else {
			return nil // not from a bot — ignore group chatter/notes
		}
	} else {
		return nil // not a bot DM — ignore
	}
	if !cfg.allowed(username) {
		return nil
	}
	sig, err := sink.Ingest(username, msg.Message, msg.ID, int64(msg.Date))
	if err != nil {
		fmt.Fprintln(os.Stderr, "tgsignals: persist:", err)
		return nil // advisory — never break the update loop
	}
	if sig != nil {
		fmt.Fprintf(os.Stderr, "tgsignals: %s %s %s\n", sig.Bot, sig.Symbol, sig.Timeframe)
	}
	return nil
}
