// Klines: public REST fetch for deep analysis (paper-safe — no keys, GET
// only). Primary is Toobit public klines (D-06 venue); Binance public klines
// is the fallback (same BTCUSDT/ETHUSDT/SOLUSDT spot symbols, universal
// millisecond close-time format). Both return oldest-first closes that the
// template's priceWindow consumes. Any failure returns an error — an analysis
// with unknown market data is NO data, never interpolated data.
package strategies

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"
)

// klinesTimeout bounds one provider call; two providers is the failover
// pairing, not an unbounded retry loop.
const klinesTimeout = 8 * time.Second

// Limit is the closes count per fetch (analysis window, not tick storage).
const klinesLimit = 120

// CandleWire is the provider-agnostic bar the template consumes.
type CandleWire struct {
	Ts     int64
	Open   string
	High   string
	Low    string
	Close  string
	Volume string
}

// ToContract converts wire bars to contract candles (decimal strings pass
// through untouched).
func (c CandleWire) ToContract() Candle {
	return Candle{
		Ts: c.Ts, Open: c.Open, High: c.High, Low: c.Low,
		Close: c.Close, Volume: c.Volume,
	}
}

// FetchKlines returns oldest-first closes for symbol/timeframe, trying
// Toobit then Binance. interval is "15m"|"1h"|"4h" (validated by caller).
func FetchKlines(symbol, interval string) ([]CandleWire, string, error) {
	if out, err := toobitKlines(symbol, interval); err == nil {
		return out, "toobit-rest", nil
	} else {
		first := err
		if out, err := binanceKlines(symbol, interval); err == nil {
			return out, "binance-rest", nil
		} else {
			return nil, "", fmt.Errorf("klines %s %s: toobit: %v; binance: %v", symbol, interval, first, err)
		}
	}
}

func getJSON(url string, v any) error {
	client := &http.Client{Timeout: klinesTimeout}
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(v)
}

func numToStr(v any) (string, bool) {
	switch n := v.(type) {
	case string:
		if _, err := strconv.ParseFloat(n, 64); err != nil {
			return "", false
		}
		return n, true
	case float64:
		return strconv.FormatFloat(n, 'f', -1, 64), true
	default:
		return "", false
	}
}

// toobitKlines: GET https://api.toobit.com/api/v1/market/kline
// (symbol=BTCUSDT, interval=15m, limit). Payload rows are
// [open_time, open, high, low, close, volume, close_time, ...].
func toobitKlines(symbol, interval string) ([]CandleWire, error) {
	var body struct {
		Code int         `json:"code"`
		Data [][]any     `json:"data"`
		Msg  string      `json:"msg"`
	}
	u := fmt.Sprintf("https://api.toobit.com/api/v1/market/kline?symbol=%s&interval=%s&limit=%d", symbol, interval, klinesLimit)
	if err := getJSON(u, &body); err != nil {
		return nil, err
	}
	if body.Code != 0 && body.Code != 200 {
		return nil, fmt.Errorf("code=%d msg=%s", body.Code, body.Msg)
	}
	return rowsToWire(body.Data)
}

// binanceKlines: GET https://api.binance.com/api/v3/klines
// rows are [open_time, open, high, low, close, volume, close_time, ...]
// with numeric strings.
func binanceKlines(symbol, interval string) ([]CandleWire, error) {
	var rows [][]any
	u := fmt.Sprintf("https://api.binance.com/api/v3/klines?symbol=%s&interval=%s&limit=%d", symbol, interval, klinesLimit)
	if err := getJSON(u, &rows); err != nil {
		return nil, err
	}
	return rowsToWire(rows)
}

func rowsToWire(rows [][]any) ([]CandleWire, error) {
	if len(rows) == 0 {
		return nil, fmt.Errorf("empty klines")
	}
	out := make([]CandleWire, 0, len(rows))
	for i, r := range rows {
		if len(r) < 6 {
			return nil, fmt.Errorf("row %d short", i)
		}
		ts, ok := toMillis(r[0])
		if !ok {
			return nil, fmt.Errorf("row %d bad open_time", i)
		}
		o, ok1 := numToStr(r[1])
		h, ok2 := numToStr(r[2])
		l, ok3 := numToStr(r[3])
		c, ok4 := numToStr(r[4])
		v, ok5 := numToStr(r[5])
		if !(ok1 && ok2 && ok3 && ok4 && ok5) {
			return nil, fmt.Errorf("row %d bad numerics", i)
		}
		out = append(out, CandleWire{Ts: ts, Open: o, High: h, Low: l, Close: c, Volume: v})
	}
	return out, nil
}

func toMillis(v any) (int64, bool) {
	switch n := v.(type) {
	case float64:
		return int64(n), true
	case string:
		if f, err := strconv.ParseFloat(n, 64); err == nil {
			return int64(f), true
		}
	}
	return 0, false
}
