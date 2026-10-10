// Package main — E00 skeleton. Full WS/watcher lands in E02/E03.
package main

import (
	"fmt"
	"net/http"
	"os"
)

func main() {
	port := os.Getenv("GO_PORT")
	if port == "" {
		port = "8080"
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { fmt.Fprintln(w, "ok") })
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) { fmt.Fprintln(w, "not-ready: E02 pending") })
	_ = http.ListenAndServe(":"+port, mux)
}
