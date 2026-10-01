FROM oven/bun:1 AS base
WORKDIR /app

FROM base AS dev
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
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
CMD ["bun", "run", "src/index.ts"]
