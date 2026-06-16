FROM oven/bun:1 AS base
WORKDIR /app

# ─────────────────────────────────────────────────────────────────────
# STORAGE-FU-AB-FIX-1 (2026-06-02) — fail-fast install verification.
#
# Both `dev` and `prod` stages run an inline `bun -e` probe immediately
# after `bun install` so a future regression that drops `sharp` or
# `ffmpeg-static` from `package.json` fails at `docker build` time
# instead of silently degrading to the FU-A/B "safe-fail to production
# stub" path at runtime (every `image_optimize` / `video_*` job would
# then dead-letter with `PROCESSOR_FAILED` after the worker retry
# budget).
#
# The probe:
#   1. `require("sharp")` — verifies the libvips binding loads.
#   2. `require("ffmpeg-static")` — verifies the module loads + returns
#      a binary path.
#   3. `fs.accessSync(path, X_OK)` — verifies the ffmpeg binary exists
#      AND is executable (catches the "module loads but binary missing"
#      edge that a pure `require()` would not catch — npm's postinstall
#      hook downloads the platform-specific binary into the package
#      directory after install).
#
# All three checks live inside a single `bun -e '...'` call so the
# Dockerfile RUN expression has no nested quote escaping (would break
# in some shells under `docker build` or `docker compose build`).
#
# Mirrors STORAGE-FU-1's `bun run db:check` posture: fail at build
# time, not at first runtime invocation.
#
# IMPORTANT (operator note): in `dev` mode the dev-stack compose file
# mounts a named volume `storage-node_modules:/app/node_modules` over
# the image's `/app/node_modules`, which SHADOWS the install verified
# here. To pick up newly-added dependencies (sharp + ffmpeg-static were
# added 2026-05-28 by FU-A/B), the operator MUST drop the stale named
# volume + force-recreate the container. See:
#   - xynes/xynes-storage-service/docs/deployment-posture.md §9.0
#   - xynes/xynes-infra/docs/plans/archive/2026-06-02-storage-fu-ab-fix-1.md
# ─────────────────────────────────────────────────────────────────────

FROM base AS dev
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
# STORAGE-FU-AB-FIX-1: fail-fast probe — both dev + prod stages must
# verify FU-A (sharp) + FU-B (ffmpeg-static) resolve + the ffmpeg
# binary is executable. The dev stage is also probed because hosted
# dev environments (no named-volume shadow) and `docker compose run
# storage-service` ad-hoc invocations both build the dev target and
# benefit from the same build-time guard.
RUN bun -e 'require("sharp"); const p = require("ffmpeg-static"); require("fs").accessSync(p, require("fs").constants.X_OK);'
COPY . .
CMD ["bun", "run", "dev"]

FROM base AS prod
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
# STORAGE-FU-AB-FIX-1: fail-fast probe — see above. The prod stage is
# the operative target for hosted environments where
# `STORAGE_PROCESSOR_MODE=live` is set; this RUN step catches a missing
# dep before the image is pushed to a registry.
RUN bun -e 'require("sharp"); const p = require("ffmpeg-static"); require("fs").accessSync(p, require("fs").constants.X_OK);'
COPY . .
CMD ["bun", "run", "start"]
