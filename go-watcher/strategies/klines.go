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
	"strings"
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
// Toobit, then OKX, then Binance. interval is "15m"|"1h"|"4h" (validated by
// caller). The chain is provider outage + symbol coverage: Toobit can 404
// rarely-listed symbols (CELR), Binance can 418/451 datacenter IPs, and each
// next provider only runs when the previous one fails — never in parallel,
// never as an unbounded retry loop.
func FetchKlines(symbol, interval string) ([]CandleWire, string, error) {
	if out, err := toobitKlines(symbol, interval); err == nil {
		return out, "toobit-rest", nil
	} else {
		first := err
		if out, err := okxKlines(symbol, interval); err == nil {
			return out, "okx-rest", nil
		} else {
			second := err
			if out, err := binanceKlines(symbol, interval); err == nil {
				return out, "binance-rest", nil
			} else {
				return nil, "", fmt.Errorf("klines %s %s: toobit: %v; okx: %v; binance: %v", symbol, interval, first, second, err)
			}
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

// toobitKlines: GET https://api.toobit.com/quote/v1/klines
// (symbol=BTCUSDT, interval=15m|1h|4h, limit). Rows are arrays
// [open_time_ms, open, high, low, close, volume, ...], oldest first.
func toobitKlines(symbol, interval string) ([]CandleWire, error) {
	var rows [][]any
	u := fmt.Sprintf("https://api.toobit.com/quote/v1/klines?symbol=%s&interval=%s&limit=%d", symbol, interval, klinesLimit)
	if err := getJSON(u, &rows); err != nil {
		return nil, err
	}
	return rowsToWire(rows)
}

// okxKlines: GET https://www.okx.com/api/v5/market/candles
// (instId=CELR-USDT, bar=1H, limit). Rows are [ts_ms, o, h, l, c, vol, ...]
// but NEWEST FIRST — they are reversed to the oldest-first wire order.
// code "0" is success, anything else is an error (e.g. unknown instrument).
func okxKlines(symbol, interval string) ([]CandleWire, error) {
	bar, ok := map[string]string{"15m": "15m", "1h": "1H", "4h": "4H"}[interval]
	if !ok {
		return nil, fmt.Errorf("interval %s not 15m|1h|4h", interval)
	}
	inst := okxInst(symbol)
	var body struct {
		Code string  `json:"code"`
		Msg  string  `json:"msg"`
		Data [][]any `json:"data"`
	}
	u := fmt.Sprintf("https://www.okx.com/api/v5/market/candles?instId=%s&bar=%s&limit=%d", inst, bar, klinesLimit)
	if err := getJSON(u, &body); err != nil {
		return nil, err
	}
	if body.Code != "0" {
		return nil, fmt.Errorf("code=%s msg=%s", body.Code, body.Msg)
	}
	for i, j := 0, len(body.Data)-1; i < j; i, j = i+1, j-1 {
		body.Data[i], body.Data[j] = body.Data[j], body.Data[i]
	}
	return rowsToWire(body.Data)
}

// okxInst maps venue symbols (CELRUSDT) to OKX instruments (CELR-USDT).
func okxInst(symbol string) string {
	if strings.HasSuffix(symbol, "USDT") && len(symbol) > 4 {
		return symbol[:len(symbol)-4] + "-USDT"
	}
	return symbol
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
