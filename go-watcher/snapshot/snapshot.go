// Package snapshot — E03-T02-S2: D1 active-snapshot reload client (stdlib-only).
// Endpoint (E05-T01 serves): GET /api/watches/active-snapshot →
// {watches:[{id,symbol,direction,trigger_json,invalidation_json,version,expires_at}], at}
// Cold start: fetch → replace in-memory ACTIVE set → resume streams from last ack.
package snapshot

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Watch is one ACTIVE watch definition from D1.
type Watch struct {
	ID               string `json:"id"`
	Symbol           string `json:"symbol"`
	Direction        string `json:"direction"`
	TriggerJSON      string `json:"trigger_json"`
	InvalidationJSON string `json:"invalidation_json"`
	Version          int    `json:"version"`
	ExpiresAt        string `json:"expires_at"`
}

// Payload is the snapshot envelope.
type Payload struct {
	Watches []Watch `json:"watches"`
	At      string  `json:"at"`
}

// Fetch downloads and validates the snapshot (empty set is valid — zero watches).
func Fetch(baseURL string, timeout time.Duration) (Payload, error) {
	var p Payload
	client := &http.Client{Timeout: timeout}
	resp, err := client.Get(baseURL + "/api/watches/active-snapshot")
	if err != nil {
		return p, fmt.Errorf("snapshot: fetch: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return p, fmt.Errorf("snapshot: status %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return p, err
	}
	if err := json.Unmarshal(body, &p); err != nil {
		return p, fmt.Errorf("snapshot: decode: %w", err)
	}
	for _, w := range p.Watches {
		if w.ID == "" || w.Symbol == "" || w.TriggerJSON == "" {
			return p, fmt.Errorf("snapshot: incomplete watch %+v", w)
		}
	}
	return p, nil
}
