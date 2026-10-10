package trigger_test

import (
	"testing"

	"trading-agent/go-watcher/trigger"
)

func TestLevelOps(t *testing.T) {
	ok, err := trigger.Eval(`{"op":">=","price":"100"}`, "100", "")
	if err != nil || !ok {
		t.Fatal(">= at level must fire")
	}
	ok, _ = trigger.Eval(`{"op":"<=","price":"100"}`, "99.9", "")
	if !ok {
		t.Fatal("<= below must fire")
	}
	ok, _ = trigger.Eval(`{"op":">=","price":"100"}`, "99", "")
	if ok {
		t.Fatal(">= below must not fire")
	}
}

func TestCrossOps(t *testing.T) {
	ok, err := trigger.Eval(`{"op":"cross_above","price":"100"}`, "101", "99")
	if err != nil || !ok {
		t.Fatal("cross_above must fire")
	}
	ok, _ = trigger.Eval(`{"op":"cross_above","price":"100"}`, "101", "102")
	if ok {
		t.Fatal("already above must not re-fire")
	}
	ok, _ = trigger.Eval(`{"op":"cross_below","price":"100"}`, "99", "101")
	if !ok {
		t.Fatal("cross_below must fire")
	}
	if _, err := trigger.Eval(`{"op":"cross_above","price":"100"}`, "101", ""); err == nil {
		t.Fatal("cross without prev must error")
	}
}

func TestBadCond(t *testing.T) {
	if _, err := trigger.Eval(`{"op":"moon","price":"1"}`, "2", ""); err == nil {
		t.Fatal("unknown op must error")
	}
	if _, err := trigger.Eval(`{nope`, "2", ""); err == nil {
		t.Fatal("bad JSON must error")
	}
}

func TestInvalidated(t *testing.T) {
	hit, err := trigger.Invalidated(`{"op":"<=","price":"90"}`, "89")
	if err != nil || !hit {
		t.Fatal("invalidation must hit")
	}
	hit, _ = trigger.Invalidated("", "1")
	if hit {
		t.Fatal("empty inval must not hit")
	}
}
