// Session storage on Redis (redisx — the repo's stdlib RESP client).
// Keys: chat:{id}:meta (hash) + chat:{id}:msgs (JSON list), both 24h TTL.
package chat

import (
	"encoding/json"
	"fmt"
	"time"

	"trading-agent/go-watcher/redisx"
)

// Store wraps redisx for chat sessions.
type Store struct{}

// NewStore builds the chat session store.
func NewStore() *Store { return &Store{} }

func metaKey(id string) string { return fmt.Sprintf("chat:%s:meta", id) }
func msgsKey(id string) string { return fmt.Sprintf("chat:%s:msgs", id) }

// Create initialises a session with (optional) principles; idempotent.
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

// Principles returns the session's stored trading principles.
func (s *Store) Principles(id string) (string, error) {
	v, err := redisx.Do("HGET", metaKey(id), "principles")
	if err != nil {
		return "", fmt.Errorf("chat: principles: %w", err)
	}
	return v, nil // empty string when the session (or field) is missing
}

// SetPrinciples updates the session's principles and refreshes TTL.
func (s *Store) SetPrinciples(id, principles string) error {
	if _, err := redisx.Do("HSET", metaKey(id), "principles", principles); err != nil {
		return fmt.Errorf("chat: set principles: %w", err)
	}
	_, _ = redisx.Do("EXPIRE", metaKey(id), "86400")
	return nil
}

// Messages returns the full stored history (oldest first).
func (s *Store) Messages(id string) ([]Message, error) {
	items, err := redisx.DoArray("LRANGE", msgsKey(id), "0", "-1")
	if err != nil {
		return nil, fmt.Errorf("chat: messages: %w", err)
	}
	out := make([]Message, 0, len(items))
	for _, it := range items {
		var m Message
		if json.Unmarshal([]byte(it), &m) == nil && m.Role != "" {
			out = append(out, m)
		}
	}
	return out, nil
}

// Append stores one turn and refreshes TTL.
func (s *Store) Append(id string, m Message) error {
	raw, err := json.Marshal(m)
	if err != nil {
		return fmt.Errorf("chat: append marshal: %w", err)
	}
	if _, err := redisx.Do("RPUSH", msgsKey(id), string(raw)); err != nil {
		return fmt.Errorf("chat: append push: %w", err)
	}
	_, _ = redisx.Do("EXPIRE", msgsKey(id), "86400")
	return nil
}

// Delete clears a session.
func (s *Store) Delete(id string) error {
	if _, err := redisx.Do("DEL", metaKey(id), msgsKey(id)); err != nil {
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
