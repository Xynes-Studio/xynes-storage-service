#!/usr/bin/env bash
# XYN-SEC-001: build and exercise the actual Linux production artifact.
set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
image_tag=${1:-local/xynes-storage:xyn-sec-001}
platform=${2:-linux/amd64}
docker build --platform "$platform" --target prod -t "$image_tag" "$repo_dir"

# Prove the Compose overlay removes development mounts and shared secret
# injection. This model contains fixture values only and is never started.
fixture_dir=$(mktemp -d)
trap 'rm -rf -- "$fixture_dir"' EXIT
cat > "$fixture_dir/base.yml" <<'YAML'
services:
  storage-service:
    build:
      context: .
      target: dev
    command: [bun, run, dev]
    env_file: [shared.env]
    environment:
      SIBLING_SECRET_FIXTURE: should-not-reach-storage
    volumes:
      - .:/app
      - fixture-deps:/app/node_modules
volumes:
  fixture-deps:
YAML
printf '%s\n' 'SHARED_SECRET_FIXTURE=should-not-reach-storage' > "$fixture_dir/shared.env"
printf '%s\n' 'DATABASE_URL=fixture-only' > "$fixture_dir/storage.env"
STORAGE_RUNTIME_ENV_FILE="$fixture_dir/storage.env" \
  docker compose --env-file "$fixture_dir/storage.env" \
  -f "$fixture_dir/base.yml" -f "$repo_dir/compose.security.yml" \
  config --format json > "$fixture_dir/resolved.json"
docker run --rm --platform "$platform" --network none --read-only \
  --cap-drop ALL --security-opt no-new-privileges --memory 1g --cpus 2 --pids-limit 128 \
  --mount "type=bind,source=$fixture_dir/resolved.json,target=/tmp/resolved.json,readonly" \
  --entrypoint bun "$image_tag" -e '
    const { services } = await Bun.file("/tmp/resolved.json").json();
    const s = services["storage-service"];
    if (s.build.target !== "prod" || s.command || s.volumes?.length ||
        s.environment.SIBLING_SECRET_FIXTURE || s.environment.SHARED_SECRET_FIXTURE ||
        s.environment.DATABASE_URL !== "fixture-only" ||
        s.environment.STORAGE_PROCESSOR_MODE !== "live" ||
        !s.read_only || s.user !== "bun" || !s.cap_drop.includes("ALL") ||
        !s.security_opt.includes("no-new-privileges:true") ||
        s.mem_limit !== "1073741824" || s.cpus !== 2 || s.pids_limit !== 128 ||
        !s.tmpfs.some(value => value.includes("noexec") && value.includes("nosuid"))) {
      throw new Error("STORAGE_COMPOSE_ISOLATION_FAILED");
    }
    console.log("Storage Compose isolation and env replacement verified");
  '

# No network, secrets or real provider/DB access. Only committed fixture tests
# are mounted; dependencies and source are the copies inside the release image.
docker run --rm --platform "$platform" --network none --read-only \
  --cap-drop ALL --security-opt no-new-privileges \
  --memory 1g --cpus 2 --pids-limit 128 \
  --tmpfs /tmp:rw,noexec,nosuid,size=256m,mode=1777 \
  --mount "type=bind,source=$repo_dir/tests,target=/app/tests,readonly" \
  "$image_tag" sh -eu -c '
    test "$(id -u)" != 0
    test ! -e /app/.env
    test ! -e /app/.git
    test ! -e /app/DEVELOPER.md
    if touch /app/.write-probe 2>/dev/null; then exit 1; fi
    bun run scripts/assert-native-image-runtime.ts
    bun test tests/infra/processors/native-image-runtime.test.ts \
      tests/actions/handlers/processing/scan-gate.test.ts \
      tests/actions/handlers/processing/worker-scan-gate.test.ts \
      tests/actions/handlers/objects/download-scan-gate.test.ts \
      tests/actions/handlers/objects/download-url.test.ts \
      tests/integration/processors/sharp.integration.test.ts \
      tests/integration/processors/image-upload-security.integration.test.ts
    bun test tests/integration/processors/immutable-source.integration.test.ts
    bun test tests/providers/s3-adapter.test.ts tests/infra/db/repositories/mappers.test.ts
  '
