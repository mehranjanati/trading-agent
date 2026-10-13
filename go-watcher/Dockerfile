# go-watcher/Dockerfile — E12-T01 (local container proof): run the Go watcher
# next to the paper stack. The module is stdlib-only (go.mod has no requires).
#
# Two build modes:
#  1) PREBUILT (default here, works offline): cross-compile on the host, then
#     `docker/go-watcher` is copied into the image. Reproduce with:
#       cd go-watcher && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
#         go build -trimpath -ldflags="-s -w" -o docker/go-watcher .
#  2) MULTI-STAGE (CI/Hetzner, when Docker Hub is reachable): replace the two
#     stages below with
#       FROM golang:1.23-alpine AS build
#       WORKDIR /src
#       COPY . .
#       RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/go-watcher .
#       FROM alpine:3.20  (rest identical)
FROM alpine:latest
# Non-root runtime user; the watcher binds :8080 (unprivileged) and talks to
# Redis + the Workers plane over outbound TCP only.
RUN adduser -D -u 10001 watcher
USER watcher
COPY docker/go-watcher /usr/local/bin/go-watcher
# Strategy registry (Phase 1): pinned .wasm artifacts + registry.json travel
# with the image. Mount ./strategies/samples over /strategies for live edit
# during development; the image copy is the deploy truth.
COPY strategies/samples /strategies
ENV GO_PORT=8080 STRATEGIES_DIR=/strategies
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/go-watcher"]