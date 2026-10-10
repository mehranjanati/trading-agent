// Package rediscmd — E03-T02-S2 helper: minimal RESP client over net.Conn (stdlib-only).
// Used by cmd/restart-drill. Production Streams I/O lands in E05/E06 with the
// same seam; no third-party client dependency in this repo (TS+Go, stdlib-first).
package main

import (
	"bufio"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"
)

func redisAddr() string { return "127.0.0.1:6379" }

func redisDo(args ...string) (string, error) {
	c, err := net.DialTimeout("tcp", redisAddr(), 3*time.Second)
	if err != nil {
		return "", err
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(3 * time.Second))
	var sb strings.Builder
	fmt.Fprintf(&sb, "*%d\r\n", len(args))
	for _, a := range args {
		fmt.Fprintf(&sb, "$%d\r\n%s\r\n", len(a), a)
	}
	if _, err := c.Write([]byte(sb.String())); err != nil {
		return "", err
	}
	br := bufio.NewReader(c)
	line, err := br.ReadString('\n')
	if err != nil {
		return "", err
	}
	switch line[0] {
	case '+':
		return strings.TrimSpace(line[1:]), nil
	case ':':
		return strings.TrimSpace(line[1:]), nil
	case '$':
		n, _ := strconv.Atoi(strings.TrimSpace(line[1:]))
		if n < 0 {
			return "", nil
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
	default:
		return "", fmt.Errorf("redis: unexpected %q", line)
	}
}
