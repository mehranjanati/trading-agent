// Command replay — E03-T01-S3: deterministic replay proof (golden fixtures).
// Reads go-watcher/testdata/*.jsonl (one normalized tick per line), evaluates a
// fixed watch set, and compares emitted evt sequence against .golden files.
// Run: go run ./cmd/replay ; exit nonzero on any divergence.
// Fixture line: {"symbol":"BTCUSDT","px":"...","ts":N,"src":"trade"}
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"

	"trading-agent/go-watcher/stream"
	"trading-agent/go-watcher/trigger"
)

type tickLine struct {
	Symbol string `json:"symbol"`
	Px     string `json:"px"`
	Ts     int64  `json:"ts"`
	Src    string `json:"src"`
}

type watchDef struct {
	ID          string
	Symbol      string
	TriggerJSON string
}

func main() {
	dir := "testdata"
	if len(os.Args) > 1 {
		dir = os.Args[1]
	}
	watches := []watchDef{
		{ID: "w_btc_long", Symbol: "BTCUSDT", TriggerJSON: `{"op":"cross_above","price":"67000"}`},
		{ID: "w_eth_short", Symbol: "ETHUSDT", TriggerJSON: `{"op":"cross_below","price":"3500"}`},
	}
	prev := map[string]string{}
	seq := map[string]int{}
	var emitted []string
	files, _ := filepath.Glob(filepath.Join(dir, "*.jsonl"))
	sort.Strings(files)
	if len(files) == 0 {
		fmt.Println("FAIL: no fixtures in", dir)
		os.Exit(1)
	}
	for _, f := range files {
		fh, err := os.Open(f)
		if err != nil {
			fmt.Println("FAIL:", err)
			os.Exit(1)
		}
		sc := bufio.NewScanner(fh)
		sc.Buffer(make([]byte, 1024*1024), 1024*1024)
		for sc.Scan() {
			var tl tickLine
			if err := json.Unmarshal(sc.Bytes(), &tl); err != nil {
				fmt.Println("FAIL bad line:", err)
				os.Exit(1)
			}
			for _, w := range watches {
				if w.Symbol != tl.Symbol {
					continue
				}
				fire, err := trigger.Eval(w.TriggerJSON, tl.Px, prev[tl.Symbol])
				if err != nil {
					if prev[tl.Symbol] == "" {
						prev[tl.Symbol] = tl.Px
						continue // first tick per symbol: no cross possible, seed prev
					}
					fmt.Println("FAIL eval:", err)
					os.Exit(1)
				}
				if fire {
					seq[w.ID]++
					evt := stream.EventID(time.UnixMilli(tl.Ts))
					fields := stream.TriggerFields(evt, w.ID, seq[w.ID], tl.Symbol, tl.Px, tl.Ts)
					emitted = append(emitted, w.ID+":"+fields["dedupe_key"]+":"+tl.Px)
				}
			}
			prev[tl.Symbol] = tl.Px
		}
		fh.Close()
	}
	// Compare against golden (dedupe_key + px only — evt IDs are random by design).
	golden, err := os.ReadFile(filepath.Join(dir, "replay.golden"))
	if err != nil {
		fmt.Println("FAIL: missing replay.golden")
		os.Exit(1)
	}
	var want []string
	for _, l := range splitLines(string(golden)) {
		if l != "" {
			want = append(want, l)
		}
	}
	if len(emitted) != len(want) {
		fmt.Printf("FAIL: emitted %d, want %d\nemitted=%v\n", len(emitted), len(want), emitted)
		os.Exit(1)
	}
	for i := range emitted {
		if emitted[i] != want[i] {
			fmt.Printf("FAIL line %d: got %s want %s\n", i, emitted[i], want[i])
			os.Exit(1)
		}
	}
	fmt.Printf("replay: PASS (%d events deterministic across %d fixtures)\n", len(emitted), len(files))
}

func splitLines(s string) []string {
	var out []string
	cur := ""
	for _, c := range s {
		if c == '\n' {
			out = append(out, cur)
			cur = ""
		} else {
			cur += string(c)
		}
	}
	return append(out, cur)
}
