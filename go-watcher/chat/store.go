// Session storage: Redis is the HOT CACHE, D1 is the CANONICAL log (ADR-014).
// Keys: chat:{id}:meta (hash) + chat:{id}:msgs (JSON list), both 24h TTL — the
// TTL is now only a cache lifetime, because every turn is mirrored to the
// Worker's /api/chat:append and a Redis miss rehydrates from D1. That is what
// stops a conversation from disappearing after a day (or a Redis restart).
package chat

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"trading-agent/go-watcher/redisx"
)

// persistTimeout bounds the mirror call so a slow Worker never stalls a turn.
const persistTimeout = 5 * time.Second

// Store wraps redisx for chat sessions plus the optional durable log.
type Store struct {
	// Remote mirrors every turn to D1 through the Worker (nil = Redis-only,
	// e.g. tests or a deployment without a reachable control plane).
	Remote *Persister
}

// NewStore builds the chat session store (Redis-only until WithRemote).
func NewStore() *Store { return &Store{} }

// WithRemote attaches the durable log. A nil persister is a no-op, so the
// caller can wire it unconditionally.
func (s *Store) WithRemote(p *Persister) *Store {
	s.Remote = p
	return s
}

func metaKey(id string) string { return fmt.Sprintf("chat:%s:meta", id) }
func msgsKey(id string) string { return fmt.Sprintf("chat:%s:msgs", id) }

// Create initialises a session with (optional) principles; idempotent. A
// symbol-derived id (sym_<SYMBOL>) therefore "creates" the same thread every
// time — the permanent per-symbol conversation.
func (s *Store) Create(id, principles string) error {
	if _, err := redisx.Do("HSET", metaKey(id), "created_at", time.Now().UTC().Format(time.RFC3339), "principles", principles); err != nil {
		return fmt.Errorf("chat: create meta: %w", err)
	}
	if _, err := redisx.Do("EXPIRE", metaKey(id), "86400"); err != nil {
		return fmt.Errorf("chat: expire meta: %w", err)
	}
	if _, err := redisx.Do("EXPIRE", msgsKey(id), "86400"); err != nil {
		return fmt.Errorf("chat: expire msgs: %w", err)
	}
	return nil
}

// Principles returns the session's stored trading principles, falling back to
// the durable row when the cache expired.
func (s *Store) Principles(id string) (string, error) {
	v, err := redisx.Do("HGET", metaKey(id), "principles")
	if err == nil && v != "" {
		return v, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), persistTimeout)
	defer cancel()
	if _, p, rerr := s.Remote.History(ctx, id, 1); rerr == nil && p != "" {
		_, _ = redisx.Do("HSET", metaKey(id), "principles", p)
		return p, nil
	}
	if err != nil {
		return "", fmt.Errorf("chat: principles: %w", err)
	}
	return v, nil // empty string when the session (or field) is missing
}

// SetPrinciples updates the session's principles and refreshes TTL. The next
// append of a turn mirrors them to D1 as well.
func (s *Store) SetPrinciples(id, principles string) error {
	if _, err := redisx.Do("HSET", metaKey(id), "principles", principles); err != nil {
		return fmt.Errorf("chat: set principles: %w", err)
	}
	_, _ = redisx.Do("EXPIRE", metaKey(id), "86400")
	return nil
}

// Messages returns the full stored history (oldest first). On a cache miss it
// reads D1 and repopulates Redis, so the 24h TTL is invisible to the client.
func (s *Store) Messages(id string) ([]Message, error) {
	items, err := redisx.DoArray("LRANGE", msgsKey(id), "0", "-1")
	if err != nil {
		if durable, _, rerr := s.remoteHistory(id, 0); rerr == nil && len(durable) > 0 {
			return durable, nil // Redis down: serve the canonical log
		}
		return nil, fmt.Errorf("chat: messages: %w", err)
	}
	out := make([]Message, 0, len(items))
	for _, it := range items {
		var m Message
		if json.Unmarshal([]byte(it), &m) == nil && m.Role != "" {
			out = append(out, m)
		}
	}
	if len(out) > 0 {
		return out, nil
	}
	durable, _, rerr := s.remoteHistory(id, 0)
	if rerr != nil || len(durable) == 0 {
		return out, nil
	}
	s.rehydrate(id, durable)
	return durable, nil
}

// Append stores one turn: Redis first (fast path), then D1 (durability).
// Fail-soft by contract — the turn is answered either way; only a total failure
// of BOTH stores is reported.
func (s *Store) Append(id string, m Message) error {
	raw, err := json.Marshal(m)
	if err != nil {
		return fmt.Errorf("chat: append marshal: %w", err)
	}
	_, redisErr := redisx.Do("RPUSH", msgsKey(id), string(raw))
	if redisErr == nil {
		_, _ = redisx.Do("EXPIRE", msgsKey(id), "86400")
	}
	ctx, cancel := context.WithTimeout(context.Background(), persistTimeout)
	defer cancel()
	persistErr := s.Remote.Append(ctx, id, m)
	if redisErr != nil && persistErr != nil {
		return fmt.Errorf("chat: append: redis=%v persist=%v", redisErr, persistErr)
	}
	return nil
}

// Delete clears a session from the cache AND the canonical log. Clearing only
// Redis would make the transcript reappear on the next read (D1 is canonical).
func (s *Store) Delete(id string) error {
	_, err := redisx.Do("DEL", metaKey(id), msgsKey(id))
	ctx, cancel := context.WithTimeout(context.Background(), persistTimeout)
	defer cancel()
	if derr := s.Remote.Delete(ctx, id); derr != nil && err == nil {
		return fmt.Errorf("chat: delete persist: %w", derr)
	}
	if err != nil {
		return fmt.Errorf("chat: delete: %w", err)
	}
	return nil
}

// Exists reports whether the session's meta key is present.
func (s *Store) Exists(id string) (bool, error) {
	v, err := redisx.Do("EXISTS", metaKey(id))
	if err != nil {
		return false, err
	}
	return v == "1", nil
}

// remoteHistory is the nil-safe D1 read used by Messages/Principles.
func (s *Store) remoteHistory(id string, limit int) ([]Message, string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), persistTimeout)
	defer cancel()
	return s.Remote.History(ctx, id, limit)
}

// rehydrate repopulates the Redis window from D1 (best-effort: a failed write
// only means the next read hits D1 again).
func (s *Store) rehydrate(id string, msgs []Message) {
	for _, m := range msgs {
		raw, err := json.Marshal(m)
		if err != nil {
			continue
		}
		if _, err := redisx.Do("RPUSH", msgsKey(id), string(raw)); err != nil {
			return
		}
	}
	_, _ = redisx.Do("EXPIRE", msgsKey(id), "86400")
}
