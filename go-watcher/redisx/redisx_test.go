// endpoint parsing: the four env shapes redisx must accept (local default,
// bare host:port, full redis:// URLs with and without credentials, and the
// rediss:// rejection). These are pure-function cases — no network, safe in CI
// where no Redis exists.
package redisx

import "testing"

func TestEndpointShapes(t *testing.T) {
	cases := []struct {
		name             string
		addr, url        string
		host, user, pass string
		wantErr          bool
	}{
		{"default", "", "", "127.0.0.1:6379", "", "", false},
		{"bare-hostport", "10.1.2.3:6380", "", "10.1.2.3:6380", "", "", false},
		{"bare-host", "kv-lan", "", "kv-lan:6379", "", "", false},
		{"render-kv", "redis://red-k1:pw9@red-k1:6379", "", "red-k1:6379", "red-k1", "pw9", false},
		{"render-kv-noport", "redis://red-k1:pw9@red-k1", "", "red-k1:6379", "red-k1", "pw9", false},
		{"nopass-url", "redis://red-k1:6379", "", "red-k1:6379", "", "", false},
		{"url-wins", "redis://a:p@h1:6381", "redis://u2:p2@h2:6382", "h2:6382", "u2", "p2", false},
		{"url-env", "", "redis://u:p@render-kv:6379", "render-kv:6379", "u", "p", false},
		{"rediss-rejected", "rediss://u:p@h:6379", "", "", "", "", true},
	}
	for _, c := range cases {
		t.Setenv("REDIS_ADDR", c.addr)
		t.Setenv("REDIS_URL", c.url)
		hp, user, pass, err := endpoint()
		if c.wantErr {
			if err == nil {
				t.Errorf("%s: want error, got nil", c.name)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: %v", c.name, err)
			continue
		}
		if hp != c.host || user != c.user || pass != c.pass {
			t.Errorf("%s = %q/%q/%q, want %q/%q/%q", c.name, hp, user, pass, c.host, c.user, c.pass)
		}
	}
}
