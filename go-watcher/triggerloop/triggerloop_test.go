// triggerloop_test.go — the evaluation loop: ACTIVE set in, deterministic fires out.
//
// What this guards: the loop is the only thing that turns a live tick into a
// watch edge, so its decisions must be reproducible (same ticks → same fires) and
// must never invent a fire (invalidation wins, one fire per ACTIVE episode, a
// malformed definition is dropped instead of firing on garbage).
package triggerloop

import (
	"testing"
	"time"

	"trading-agent/go-watcher/normalize"
	"trading-agent/go-watcher/trigger"
)

func def(id, symbol, trig, inval string) trigger.Definition {
	return trigger.Definition{ID: id, Symbol: symbol, TriggerJSON: trig, InvalJSON: inval}
}

func tick(symbol, px string) normalize.Tick {
	return normalize.Tick{Symbol: symbol, Price: px, Ts: 1_760_000_000_000, Src: "trade"}
}

func TestLevelTriggerFiresOncePerActiveEpisode(t *testing.T) {
	e := New()
	e.Set([]trigger.Definition{def("w1", "BTCUSDT", `{"op":">=","price":"100"}`, `{}`)})

	if fires := e.Apply(tick("BTCUSDT", "99")); len(fires) != 0 {
		t.Fatalf("below the level must not fire, got %+v", fires)
	}
	fires := e.Apply(tick("BTCUSDT", "100"))
	if len(fires) != 1 || fires[0].Kind != Triggered || fires[0].Seq != 1 {
		t.Fatalf("level hit must fire once, got %+v", fires)
	}
	if fires[0].Px != "100" || fires[0].PrevPx != "99" {
		t.Fatalf("fire must carry the deciding tick and its predecessor: %+v", fires[0])
	}
	// Still ACTIVE in D1 but already fired locally: no second fire until a reload
	// says otherwise (that is what keeps dedupe_key seq monotonic).
	if fires := e.Apply(tick("BTCUSDT", "101")); len(fires) != 0 {
		t.Fatalf("a fired watch must not fire again before reload, got %+v", fires)
	}
	// A reload that still lists it as ACTIVE (re-armed) starts a new episode.
	e.Set([]trigger.Definition{def("w1", "BTCUSDT", `{"op":">=","price":"100"}`, `{}`)})
	fires = e.Apply(tick("BTCUSDT", "102"))
	if len(fires) != 1 || fires[0].Seq != 2 {
		t.Fatalf("re-armed watch must fire again with seq 2, got %+v", fires)
	}
}

func TestInvalidationWinsOverTrigger(t *testing.T) {
	e := New()
	// Both conditions true at px=90: the zone broke, so INVALIDATED (never an
	// entry on a broken zone).
	e.Set([]trigger.Definition{def("w1", "BTCUSDT", `{"op":"<=","price":"95"}`, `{"op":"<=","price":"92"}`)})
	fires := e.Apply(tick("BTCUSDT", "90"))
	if len(fires) != 1 || fires[0].Kind != Invalidated {
		t.Fatalf("invalidation must win, got %+v", fires)
	}
}

func TestCrossNeedsTwoTicks(t *testing.T) {
	e := New()
	e.Set([]trigger.Definition{def("w1", "ETHUSDT", `{"op":"cross_above","price":"3000"}`, `{}`)})
	if fires := e.Apply(tick("ETHUSDT", "3001")); len(fires) != 0 {
		t.Fatalf("a cross cannot be decided on the first tick (no prev), got %+v", fires)
	}
	if fires := e.Apply(tick("ETHUSDT", "2999")); len(fires) != 0 {
		t.Fatalf("prev below + cur below is not a cross, got %+v", fires)
	}
	fires := e.Apply(tick("ETHUSDT", "3000"))
	if len(fires) != 1 || fires[0].Kind != Triggered {
		t.Fatalf("2999 → 3000 crosses the level, got %+v", fires)
	}
}

func TestConfirmTicksRequiresConsecutiveMatches(t *testing.T) {
	e := New()
	e.Set([]trigger.Definition{def("w1", "SOLUSDT", `{"op":">=","price":"100","confirm_ticks":3}`, `{}`)})
	if fires := e.Apply(tick("SOLUSDT", "101")); len(fires) != 0 {
		t.Fatalf("1/3 confirmations must not fire, got %+v", fires)
	}
	if fires := e.Apply(tick("SOLUSDT", "99")); len(fires) != 0 {
		t.Fatalf("a miss must not fire, got %+v", fires)
	}
	if fires := e.Apply(tick("SOLUSDT", "101")); len(fires) != 0 {
		t.Fatalf("the miss must reset the counter (1/3), got %+v", fires)
	}
	if fires := e.Apply(tick("SOLUSDT", "102")); len(fires) != 0 {
		t.Fatalf("2/3 must not fire, got %+v", fires)
	}
	fires := e.Apply(tick("SOLUSDT", "103"))
	if len(fires) != 1 || fires[0].Seq != 1 {
		t.Fatalf("3/3 must fire, got %+v", fires)
	}
}

func TestSymbolIsolationAndUnknownSymbols(t *testing.T) {
	e := New()
	e.Set([]trigger.Definition{
		def("w1", "BTCUSDT", `{"op":">=","price":"100"}`, `{}`),
		def("w2", "ETHUSDT", `{"op":">=","price":"100"}`, `{}`),
	})
	// A tick for a symbol nobody watches still updates the last-px map (cheap)
	// but decides nothing.
	if fires := e.Apply(tick("XRPUSDT", "5")); len(fires) != 0 {
		t.Fatalf("unwatched symbol must not fire, got %+v", fires)
	}
	fires := e.Apply(tick("ETHUSDT", "100"))
	if len(fires) != 1 || fires[0].WatchID != "w2" {
		t.Fatalf("only the matching watch fires, got %+v", fires)
	}
	if fires := e.Apply(tick("BTCUSDT", "100")); len(fires) != 1 || fires[0].WatchID != "w1" {
		t.Fatalf("the other watch is independent, got %+v", fires)
	}
}

func TestSetDropsUnevaluableDefinitions(t *testing.T) {
	e := New()
	e.Set([]trigger.Definition{
		def("bad-op", "BTCUSDT", `{"op":"~=","price":"100"}`, `{}`),
		def("bad-price", "BTCUSDT", `{"op":">=","price":"abc"}`, `{}`),
		def("no-id", "", `{"op":">=","price":"100"}`, `{}`),
		def("good", "BTCUSDT", `{"op":">=","price":"100"}`, `{}`),
	})
	if got := e.Skipped(); got != 3 {
		t.Fatalf("three unusable definitions must be counted, got %d", got)
	}
	fires := e.Apply(tick("BTCUSDT", "100"))
	if len(fires) != 1 || fires[0].WatchID != "good" {
		t.Fatalf("only the evaluable definition may fire, got %+v", fires)
	}
}

func TestFiresAreDeterministic(t *testing.T) {
	run := func() []Fire {
		e := New()
		e.Set([]trigger.Definition{
			def("w1", "BTCUSDT", `{"op":"cross_above","price":"100"}`, `{"op":"<=","price":"90"}`),
			def("w2", "BTCUSDT", `{"op":">=","price":"105"}`, `{}`),
		})
		seq := []string{"95", "99", "101", "106", "88"}
		var out []Fire
		for _, px := range seq {
			out = append(out, e.Apply(tick("BTCUSDT", px))...)
		}
		return out
	}
	a, b := run(), run()
	if len(a) != len(b) || len(a) == 0 {
		t.Fatalf("replay must produce the same fire count: %d vs %d", len(a), len(b))
	}
	for i := range a {
		if a[i] != b[i] {
			t.Fatalf("fire %d differs between replays: %+v vs %+v", i, a[i], b[i])
		}
	}
	// w1 crosses 100 at tick 3 (99 → 101); w2 hits 105 at tick 4.
	if len(a) != 2 || a[0].WatchID != "w1" || a[1].WatchID != "w2" {
		t.Fatalf("unexpected fire sequence: %+v", a)
	}
	if !a[0].At.Equal(time.UnixMilli(1_760_000_000_000).UTC()) {
		t.Fatalf("fire time must come from the tick, not a local clock: %v", a[0].At)
	}
}

func TestSymbolsListsTheActiveSet(t *testing.T) {
	e := New()
	e.Set([]trigger.Definition{
		def("w1", "BTCUSDT", `{"op":">=","price":"1"}`, `{}`),
		def("w2", "BTCUSDT", `{"op":">=","price":"2"}`, `{}`),
		def("w3", "ETHUSDT", `{"op":">=","price":"3"}`, `{}`),
	})
	if got := len(e.Symbols()); got != 2 {
		t.Fatalf("two distinct symbols expected, got %d", got)
	}
}
