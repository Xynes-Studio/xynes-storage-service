# Build-only toolchain; no Go distribution is present in the runtime image.
FROM golang:1.27.1-bookworm AS build
WORKDIR /src
COPY go.mod *.go ./
RUN CGO_ENABLED=0 go test ./... && CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /scanner .

# Exact tested scanner engine, including its immutable image digest.
FROM clamav/clamav:1.5.2-debian@sha256:12a74204d5723b39de2dcb20ab679752ca5d30b1a1539646b2cd9f58a873e8c6
COPY --from=build /scanner /usr/local/bin/xynes-archive-scanner
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/xynes-archive-scanner"]
# The public port belongs to the supervisor, which only starts after clamd PING.
HEALTHCHECK NONE
