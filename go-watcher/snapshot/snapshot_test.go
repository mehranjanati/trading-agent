package snapshot_test

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"trading-agent/go-watcher/snapshot"
)

func TestFetchOK(t *testing.T) {
	// S2 acceptance: snapshot populates the ACTIVE set (2 watches).
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/watches/active-snapshot" {
			t.Fatalf("bad path %s", r.URL.Path)
		}
		w.Write([]byte(`{"watches":[{"id":"w1","symbol":"BTCUSDT","direction":"LONG","trigger_json":"{}","invalidation_json":"{}","version":2,"expires_at":""},{"id":"w2","symbol":"ETHUSDT","direction":"SHORT","trigger_json":"{}","invalidation_json":"{}","version":1,"expires_at":""}],"at":"now"}`))
	}))
	defer srv.Close()
	p, err := snapshot.Fetch(srv.URL, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Watches) != 2 || p.Watches[0].Version != 2 {
		t.Fatalf("bad payload: %+v", p)
	}
}

func TestFetchErrors(t *testing.T) {
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(503)
	}))
	defer bad.Close()
	if _, err := snapshot.Fetch(bad.URL, 2*time.Second); err == nil {
		t.Fatal("503 must error")
	}
	empty := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"watches":[],"at":"now"}`))
	}))
	defer empty.Close()
	p, err := snapshot.Fetch(empty.URL, 2*time.Second)
	if err != nil || len(p.Watches) != 0 {
		t.Fatal("empty set must be valid")
	}
}
