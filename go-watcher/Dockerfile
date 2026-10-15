# go-watcher/Dockerfile — run the Go watcher next to the paper stack.
#
# MULTI-STAGE: compiles inside the image, so any Docker host (Render, CI,
# Hetzner, local) builds straight from the repo — no prebuilt-binary step.
#   docker build -t go-watcher go-watcher
# The module is stdlib-only except wazero + coder/websocket (go.mod).
FROM golang:1.27-alpine AS build
WORKDIR /src
# Deps first: go.mod/go.sum layers stay cached across source-only changes.
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/go-watcher .

# Non-root runtime user; the watcher binds :8080 (unprivileged) and talks to
# Redis + the Workers plane over outbound TCP only.
FROM alpine:latest
RUN adduser -D -u 10001 watcher
USER watcher
COPY --from=build /out/go-watcher /usr/local/bin/go-watcher
# Strategy registry (Phase 1): pinned .wasm artifacts + registry.json travel
# with the image. Mount ./strategies/samples over /strategies for live edit
# during development; the image copy is the deploy truth.
COPY strategies/samples /strategies
# No baked GO_PORT: a default in the image would beat the platform's $PORT.
# Bare runs fall back to 8080 in code; compose passes GO_PORT explicitly.
ENV STRATEGIES_DIR=/strategies
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/go-watcher"]