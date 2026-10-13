// cmd/chatd — the chat service binary: HTTP + WebSocket on :8081 (CHAT_PORT),
// sessions in Redis, AI delegated to the Worker chat:stream endpoint.
package main

import (
	"fmt"
	"net/http"
	"os"

	"trading-agent/go-watcher/chat"
)

func main() {
	port := os.Getenv("CHAT_PORT")
	if port == "" {
		port = "8081"
	}
	workers := os.Getenv("WORKERS_URL")
	if workers == "" {
		fmt.Fprintln(os.Stderr, "chatd: WORKERS_URL required (AI plane)")
		os.Exit(1)
	}
	svc := &chat.Service{Store: chat.NewStore(), AI: chat.NewAIClient(workers)}
	mux := http.NewServeMux()
	mux.Handle("/", svc.Handler())
	// CORS for the dashboard (dev: localhost:3000; prod: pages.dev).
	handler := withCORS(mux)
	fmt.Fprintf(os.Stderr, "chatd: ready on :%s (workers=%s)\n", port, workers)
	if err := http.ListenAndServe(":"+port, handler); err != nil {
		fmt.Fprintln(os.Stderr, "chatd:", err)
		os.Exit(1)
	}
}

// withCORS allows the dashboard origins on chat reads/writes. The chat
// service is advisory; it has no order/approval surface at all.
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "content-type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}