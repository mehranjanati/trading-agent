// Package redisx — E06-T02-W0.1: minimal RESP client over net.Conn (stdlib-only).
// Lifted out of cmd/restart-drill (E03-T02-S2) so the drills, the heartbeat
// publisher and the later production Streams loop share one seam. No third-party
// Redis client in this repo (TS+Go, stdlib-first).
package redisx

import (
	"bufio"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"time"
)

// Timeout bounds every call so a stalled Redis can never block a caller.
const Timeout = 3 * time.Second

// Addr is the Redis endpoint: REDIS_ADDR override, else the local default.
func Addr() string {
	if a := os.Getenv("REDIS_ADDR"); a != "" {
		return a
	}
	return "127.0.0.1:6379"
}

// Do runs one command and returns the reply as a string: simple status (+OK),
// integer (:1) and bulk string ($n) replies are supported. An error reply
// (-ERR ...) is returned as an error.
func Do(args ...string) (string, error) {
	c, err := dial()
	if err != nil {
		return "", err
	}
	defer c.Close()
	if _, err := c.Write([]byte(command(args))); err != nil {
		return "", err
	}
	br := bufio.NewReader(c)
	line, err := br.ReadString('\n')
	if err != nil {
		return "", err
	}
	switch line[0] {
	case '+', ':':
		return strings.TrimSpace(line[1:]), nil
	case '$':
		return readBulk(br, line)
	case '-':
		return "", fmt.Errorf("redis: %s", strings.TrimSpace(line[1:]))
	default:
		return "", fmt.Errorf("redis: unexpected %q", line)
	}
}

// DoArray runs one command and flattens a multi-bulk reply depth-first into the
// bulk strings it contains (XREVRANGE / XINFO shape). Status and integer items
// are skipped, so `XREVRANGE key + - COUNT 1` yields the newest entry ID first.
func DoArray(args ...string) ([]string, error) {
	c, err := dial()
	if err != nil {
		return nil, err
	}
	defer c.Close()
	if _, err := c.Write([]byte(command(args))); err != nil {
		return nil, err
	}
	return readArray(bufio.NewReader(c), 0)
}

func dial() (net.Conn, error) {
	c, err := net.DialTimeout("tcp", Addr(), Timeout)
	if err != nil {
		return nil, err
	}
	_ = c.SetDeadline(time.Now().Add(Timeout))
	return c, nil
}

// command renders args as a RESP array of bulk strings.
func command(args []string) string {
	var sb strings.Builder
	fmt.Fprintf(&sb, "*%d\r\n", len(args))
	for _, a := range args {
		fmt.Fprintf(&sb, "$%d\r\n%s\r\n", len(a), a)
	}
	return sb.String()
}

func readBulk(br *bufio.Reader, header string) (string, error) {
	n, err := strconv.Atoi(strings.TrimSpace(header[1:]))
	if err != nil {
		return "", fmt.Errorf("redis: bad bulk length %q", header)
	}
	if n < 0 {
		return "", nil // (nil) bulk — key missing
	}
	buf := make([]byte, n+2)
	for i := 0; i < n+2; {
		m, err := br.Read(buf[i:])
		if err != nil {
			return "", err
		}
		i += m
	}
	return string(buf[:n]), nil
}

// readArray flattens a nested RESP reply into its bulk strings (depth-capped).
func readArray(br *bufio.Reader, depth int) ([]string, error) {
	if depth > 8 {
		return nil, fmt.Errorf("redis: reply nesting too deep")
	}
	line, err := br.ReadString('\n')
	if err != nil {
		return nil, err
	}
	switch line[0] {
	case '$':
		s, err := readBulk(br, line)
		if err != nil {
			return nil, err
		}
		return []string{s}, nil
	case '*', '~':
		n, err := strconv.Atoi(strings.TrimSpace(line[1:]))
		if err != nil {
			return nil, fmt.Errorf("redis: bad array length %q", line)
		}
		var out []string
		for i := 0; i < n; i++ {
			items, err := readArray(br, depth+1)
			if err != nil {
				return nil, err
			}
			out = append(out, items...)
		}
		return out, nil
	case '+', ':':
		return nil, nil
	case '-':
		return nil, fmt.Errorf("redis: %s", strings.TrimSpace(line[1:]))
	default:
		return nil, fmt.Errorf("redis: unexpected %q", line)
	}
}
