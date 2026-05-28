# STORAGE-FU-5-FU-G — LibreOffice sidecar image with Bun HTTP shim.
#
# Builds a slim image that bundles `soffice` (headless) behind a Bun
# HTTP shim that serves `POST /convert` + `GET /health` on TCP 8100.
#
# Wire contract (consumed byte-for-byte by FU-C's
# `LibreOfficeDocumentProcessor` in xynes-storage-service):
#
#   POST /convert
#     Body:  application/json — { sourceContentType: string, bytes: <base64> }
#     200:   Content-Type: image/png | image/jpeg + raw image bytes
#            Optional: X-Document-Page-Width / X-Document-Page-Height (positive ints)
#     4xx:   unsupported MIME / malformed input → FU-C maps to UNSUPPORTED_FORMAT (non-retryable)
#     5xx:   soffice crash / OOM / timeout    → FU-C maps to PROCESSOR_FAILED (retryable)
#
#   GET /health
#     200 { "status": "ok" }   when soffice is launchable + one-shot test conversion succeeded
#     503 { "status": "degraded" } when the binary is missing / recent crash / queue saturated
#
# Security posture (mirrors FU-E §3 + plan §12.5):
#   - Runs as a non-root user (uid=10001, no shell login).
#   - Read-only root FS at runtime — writes only to /tmp (tmpfs mounted by the orchestrator).
#   - `cap_drop: [ALL]` + `no-new-privileges:true` enforced by the orchestrator
#     (Compose overlay + K8s securityContext).
#   - `SAL_DISABLE_MACROS=1` baked into the image (defense in depth on top of FU-E).
#   - NEVER echoes request bytes, library version strings, or soffice stderr in
#     response bodies (the shim scrubs these; FU-C scrubs again — defense in depth).
#
# Build:
#   docker build -t xynes/libreoffice-sidecar:0.1.0 .
#
# Run (dev / smoke):
#   docker run --rm -p 8100:8100 xynes/libreoffice-sidecar:0.1.0
#
# Image size budget: < 600 MB (plan §12.5 acceptance criteria).
# Mitigation for soffice memory leaks: shim spawns a FRESH `soffice
# --headless --convert-to` per request (NO daemon mode); per-request
# tmpdir is wiped on exit.

# ── Stage 1: Bun runtime source (copy the bun binary into our base) ─────
FROM oven/bun:1.1-debian AS bun-source

# ── Stage 2: Final runtime image ────────────────────────────────────────
# Debian slim — same Debian family as the bun-source image so the bun
# binary is ABI-compatible. We install ONLY the LibreOffice subpackages
# that headless first-page rendering needs (NOT the GUI components,
# NOT the language packs we don't ship).
FROM debian:12-slim AS runtime

ARG SIDECAR_VERSION=0.1.0
LABEL org.opencontainers.image.title="xynes-libreoffice-sidecar"
LABEL org.opencontainers.image.version="${SIDECAR_VERSION}"
LABEL org.opencontainers.image.source="https://github.com/Xynes-Studio/xynes-infra"
LABEL org.opencontainers.image.description="LibreOffice headless + Bun HTTP shim for storage-service document previews (STORAGE-FU-5-FU-G)."

# Avoid the apt prompts; never cache apt lists in the final image.
ENV DEBIAN_FRONTEND=noninteractive

# Install LibreOffice headless components + the JRE-less core packages.
# We deliberately AVOID `libreoffice` (the meta-package) because it
# pulls the full GUI stack (~1.4 GB) — `libreoffice-core` + the four
# format-specific subpackages give us PDF / DOCX / XLSX / PPTX / ODT
# / RTF coverage in ~400 MB which matches FU-E §6 budget.
#
# - libreoffice-core            : the soffice binary + cross-format engine
# - libreoffice-writer          : DOCX / ODT / RTF
# - libreoffice-calc            : XLSX / ODS
# - libreoffice-impress         : PPTX / ODP
# - libreoffice-draw            : PDF rendering pipeline (Impress imports PDF via Draw)
# - fonts-liberation            : Helvetica/Arial/Times substitutes
# - fonts-dejavu-core           : broad Unicode coverage
# - ca-certificates             : harmless; lets Bun's runtime fetch TLS internally if needed
# - tini                        : PID-1 init that reaps zombie soffice processes
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    libreoffice-core \
    libreoffice-writer \
    libreoffice-calc \
    libreoffice-impress \
    libreoffice-draw \
    fonts-liberation \
    fonts-dejavu-core \
    ca-certificates \
    tini \
  && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* \
  && apt-get clean

# Copy the bun binary from the bun-source stage. Pinning to bun 1.1
# matches the storage-service runtime so `Bun.spawn` and `Bun.serve`
# semantics are identical to what FU-C's tests assume.
COPY --from=bun-source /usr/local/bin/bun /usr/local/bin/bun

# Non-root user — uid 10001 matches FU-G acceptance criteria. No
# shell login — the user has /usr/sbin/nologin so a successful exploit
# cannot pivot through `su` / `sh` / `bash`.
RUN groupadd --system --gid 10001 xynes \
  && useradd --system --uid 10001 --gid xynes \
       --home-dir /app --shell /usr/sbin/nologin xynes \
  && mkdir -p /app \
  && chown -R xynes:xynes /app

WORKDIR /app

# Copy shim source. The shim is dependency-free at runtime
# (uses only Bun.serve / Bun.spawn / std crypto.randomUUID) — no
# package.json install required. Tests run against the source via
# `bun test` from the build host, not inside the runtime image.
COPY --chown=xynes:xynes src/ ./src/

# ── Image-level env (defense in depth on top of FU-E orchestrator env) ──
#
# SAL_DISABLE_MACROS=1 closes the macro RCE surface against malicious
# documents at the soffice process level. FU-E also sets this on the
# container env; baking it here means a hostile orchestrator that
# strips the env cannot re-enable macros.
ENV SAL_DISABLE_MACROS=1 \
    # soffice needs a writable home for the lock dir; we point at /tmp
    # which is tmpfs at runtime.
    HOME=/tmp \
    # Avoid the system-wide /root/.config attempt soffice makes on
    # first launch.
    XDG_CONFIG_HOME=/tmp/.config \
    XDG_CACHE_HOME=/tmp/.cache \
    # JRE-less; we don't bundle Java. Setting this prevents soffice
    # from spending startup time hunting for a JRE that isn't there.
    SAL_USE_COMMON_ONE_ACCEL=0

# Switch to non-root BEFORE EXPOSE so the runtime cannot pivot.
USER xynes

# Pod-local port only — never published to the host in production
# (see FU-E Compose overlay + K8s draft).
EXPOSE 8100

# tini reaps soffice zombies on every per-request spawn — critical
# because the shim deliberately uses spawn-per-request (NO daemon
# mode) to mitigate the soffice memory-leak history documented in
# plan §12.5 risk register.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "run", "src/shim.ts"]
