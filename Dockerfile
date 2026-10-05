# STORAGE-FU-AB-FIX-1: verify installed live processor binaries in both targets.
FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS base
WORKDIR /app

FROM base AS dev
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
RUN bun -e 'require("sharp"); const p = require("ffmpeg-static"); require("fs").accessSync(p, require("fs").constants.X_OK); if (Bun.spawnSync([p, "-version"]).exitCode !== 0) throw new Error("FFMPEG_UNAVAILABLE");'
COPY . .
CMD ["bun", "run", "dev"]

FROM base AS production-dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY scripts/assert-native-image-runtime.ts ./scripts/assert-native-image-runtime.ts
# Inspect Linux libraries loaded by Sharp, rather than trusting package versions.
RUN bun run scripts/assert-native-image-runtime.ts

FROM base AS prod
ENV NODE_ENV=production
COPY --from=production-dependencies /app/package.json /app/bun.lock ./
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=production-dependencies /app/src ./src
COPY --from=production-dependencies /app/scripts ./scripts
USER bun
# Verify binaries in the final runtime as its non-root user.
RUN bun -e 'require("sharp"); const p = require("ffmpeg-static"); require("fs").accessSync(p, require("fs").constants.X_OK); if (Bun.spawnSync([p, "-version"]).exitCode !== 0) throw new Error("FFMPEG_UNAVAILABLE");'
CMD ["bun", "run", "src/index.ts"]
