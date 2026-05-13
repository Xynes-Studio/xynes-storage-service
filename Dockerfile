FROM oven/bun:1 AS base
WORKDIR /app

FROM base AS dev
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
CMD ["bun", "run", "dev"]

FROM base AS prod
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY . .
CMD ["bun", "run", "start"]
