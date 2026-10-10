package freshness_test

import (
	"testing"

	"trading-agent/go-watcher/freshness"
)

func TestMajorAltLimits(t *testing.T) {
	th := freshness.Default()
	if th.LimitMs("BTCUSDT") != 5000 || th.LimitMs("DOGEUSDT") != 10000 {
		t.Fatal("Q-04 default thresholds drift")
	}
}

func TestStaleBoundary(t *testing.T) {
	th := freshness.Default()
	// S1 acceptance: old tick → stale; fresh → not.
	if stale, _ := th.Stale("BTCUSDT", 1000, 9000); !stale {
		t.Fatal("8s-old BTC must be stale (>5s)")
	}
	if stale, _ := th.Stale("BTCUSDT", 8000, 9000); stale {
		t.Fatal("1s-old BTC must be fresh")
	}
	if stale, _ := th.Stale("DOGEUSDT", 1000, 9000); stale {
		t.Fatal("8s-old alt must be fresh (<10s alt limit)")
	}
	if stale, _ := th.Stale("DOGEUSDT", 0, 15000); !stale {
		t.Fatal("15s-old alt must be stale")
	}
}

func TestSkewFlag(t *testing.T) {
	th := freshness.Default()
	if _, skew := th.Stale("BTCUSDT", 9999, 1000); !skew {
		t.Fatal("future tick must flag skew, not stale")
	}
}
