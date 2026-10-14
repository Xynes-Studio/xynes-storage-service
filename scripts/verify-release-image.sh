#!/usr/bin/env bash
# XYN-SEC-001/005: verify the actual Linux artifact and private-context exclusion.
set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
image_tag=${1:-local/xynes-storage:xyn-sec-001}
platform=${2:-linux/amd64}
docker build --platform "$platform" --target prod -t "$image_tag" "$repo_dir"

# Prove the Compose overlay removes development mounts and shared secret
# injection. This model contains fixture values only and is never started.
fixture_dir=$(mktemp -d)
context_tag="local/xynes-storage:sec005-context-${fixture_dir##*/}"
smoke_container=""
init_container=""
control_volume=""
secret_volume=""
fixture_nonce=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
[[ "$fixture_nonce" =~ ^[a-f0-9]{32}$ ]] || exit 1
cleanup_owned_container() {
  local target=$1
  if docker container inspect "$target" >/dev/null 2>&1; then
    [[ $(docker container inspect --format '{{index .Config.Labels "com.xynes.release-fixture"}}' "$target") == "$fixture_nonce" ]] || return 1
    docker rm -f "$target" >/dev/null
  fi
}
cleanup_fixture() {
  local status=$? cleanup_failed=0 volume
  trap - EXIT
  for target in "$smoke_container" "$init_container"; do
    if [[ -n "$target" ]]; then cleanup_owned_container "$target" || cleanup_failed=1; fi
  done
  for volume in "$control_volume" "$secret_volume"; do
    if [[ -n "$volume" ]] && docker volume inspect "$volume" >/dev/null 2>&1; then
      if [[ $(docker volume inspect --format '{{index .Labels "com.xynes.release-fixture"}}' "$volume") == "$fixture_nonce" ]]; then
        docker volume rm "$volume" >/dev/null || cleanup_failed=1
      else cleanup_failed=1; fi
    fi
  done
  if docker image inspect "$context_tag" >/dev/null 2>&1; then
    if [[ $(docker image inspect --format '{{index .Config.Labels "com.xynes.release-fixture"}}' "$context_tag") == "$fixture_nonce" ]]; then
      docker image rm "$context_tag" >/dev/null || cleanup_failed=1
    else cleanup_failed=1; fi
  fi
  rm -rf -- "$fixture_dir"
  if [[ "$cleanup_failed" != 0 ]]; then echo "STORAGE_FIXTURE_OWNED_CLEANUP_FAILED" >&2; status=1; fi
  exit "$status"
}
trap cleanup_fixture EXIT

# Exercise Docker's actual context filtering using synthetic private files, not
# regex approximations or a developer's local secrets. The appended test stage
# exists only in this disposable context; the release image uses the real repo.
context_dir="$fixture_dir/context"
mkdir -p "$context_dir/src/nested" "$context_dir/scripts" "$context_dir/tests" \
  "$context_dir/.git" "$context_dir/.aws" "$context_dir/src/.ssh" \
  "$context_dir/src/nested/.aws" "$context_dir/node_modules" \
  "$context_dir/tests/.aws" "$context_dir/tests/.ssh" "$context_dir/tests/.git" \
  "$context_dir/tests/node_modules" "$context_dir/tests/coverage"
cp "$repo_dir/Dockerfile" "$repo_dir/Dockerfile.dockerignore" "$context_dir/"
for path in package.json bun.lock src/index.ts src/nested/runtime.ts \
  scripts/run-with-env.ts scripts/assert-native-image-runtime.ts tests/fixture.txt \
  .git/config .aws/credentials .env .env.dev .npmrc .netrc \
  node_modules/sec005-host-canary.txt DEVELOPER.md sec005-build-canary.txt \
  src/.env src/nested/.env.local src/private.pem src/private.key \
  src/nested/private.p12 src/nested/private.pfx src/.ssh/private.ts \
  src/nested/.aws/private.ts src/sec005-canary.txt scripts/sec005-canary.sh \
  tests/.aws/private.ts tests/.ssh/private.ts tests/.git/private.ts \
  tests/node_modules/private.ts tests/coverage/private.ts tests/private.pem \
  tests/private.key tests/private.p12 tests/private.pfx tests/.env \
  tests/.env.local tests/.npmrc tests/.netrc tests/private.log; do
  printf '%s\n' 'SEC005_INERT_BUILD_CONTEXT_CANARY' > "$context_dir/$path"
done
cat >> "$context_dir/Dockerfile" <<'DOCKERFILE'

FROM base AS sec005-context-check
ARG SEC005_FIXTURE_NONCE
LABEL com.xynes.release-fixture=$SEC005_FIXTURE_NONCE
COPY . /context
USER bun
DOCKERFILE
docker build --platform "$platform" --target sec005-context-check --build-arg "SEC005_FIXTURE_NONCE=$fixture_nonce" \
  -t "$context_tag" "$context_dir"
docker run --rm --platform "$platform" --network none --read-only \
  --cap-drop ALL --security-opt no-new-privileges --entrypoint sh "$context_tag" -eu -c '
    for path in package.json bun.lock src/index.ts src/nested/runtime.ts \
      scripts/run-with-env.ts scripts/assert-native-image-runtime.ts tests/fixture.txt; do
      test -f "/context/$path" || { echo "Missing required build input: $path" >&2; exit 1; }
    done
    for path in .git .aws .env .env.dev .npmrc .netrc node_modules DEVELOPER.md \
      sec005-build-canary.txt src/.env src/nested/.env.local src/private.pem \
      src/private.key src/nested/private.p12 src/nested/private.pfx \
      src/.ssh src/nested/.aws src/sec005-canary.txt scripts/sec005-canary.sh \
      tests/.aws tests/.ssh tests/.git tests/node_modules tests/coverage \
      tests/private.pem tests/private.key tests/private.p12 tests/private.pfx \
      tests/.env tests/.env.local tests/.npmrc tests/.netrc tests/private.log; do
      test ! -e "/context/$path" || { echo "Excluded build input admitted: $path" >&2; exit 1; }
    done
    echo "Storage build-context allowlist and private-file exclusion verified"
  '

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
    const files = require("node:fs").readdirSync("/app").sort();
    if (JSON.stringify(files) !== JSON.stringify([
      "bun.lock", "node_modules", "package.json", "scripts", "src"
    ])) throw new Error("STORAGE_RELEASE_FILE_MANIFEST_FAILED");
    console.log("Storage Compose isolation, env replacement and unmounted manifest verified");
  '

# No network, secrets or real provider/DB access. Only committed fixture tests
# are mounted; dependencies and source are the copies inside the release image.
docker run --rm --platform "$platform" --network none --read-only \
  --cap-drop ALL --security-opt no-new-privileges \
  --memory 1g --cpus 2 --pids-limit 128 \
  --tmpfs /tmp:rw,noexec,nosuid,size=256m,mode=1777 \
  --env STORAGE_RELEASE_IMAGE_TEST=1 \
  --env STORAGE_INTEGRATION_PROCESSORS_REQUIRED=1 \
  --mount "type=bind,source=$repo_dir/tests,target=/app/tests,readonly" \
  "$image_tag" sh -eu -c '
    test "$(id -u)" != 0
    test ! -e /app/.env
    test ! -e /app/.git
    test ! -e /app/DEVELOPER.md
    if touch /app/.write-probe 2>/dev/null; then exit 1; fi
    export PATH="/app/node_modules/ffmpeg-static:$PATH"
    bun test tests/security/release-image.test.ts
    bun run scripts/assert-native-image-runtime.ts
    bun test --timeout 30000 tests/infra/processors/native-image-runtime.test.ts \
      tests/actions/handlers/processing/scan-gate.test.ts \
      tests/actions/handlers/processing/worker-scan-gate.test.ts \
      tests/actions/handlers/objects/download-scan-gate.test.ts \
      tests/actions/handlers/objects/download-url.test.ts \
      tests/integration/processors/sharp.integration.test.ts \
      tests/integration/processors/ffmpeg.integration.test.ts \
      tests/integration/processors/image-upload-security.integration.test.ts
    bun test --timeout 30000 tests/integration/processors/immutable-source.integration.test.ts
    bun test tests/providers/s3-adapter.test.ts tests/infra/db/repositories/mappers.test.ts
  '

# Exercise the real production CMD as hosted UID1001. Earlier artifact gates
# retain the Dockerfile's default bun UID1000. Only disposable labeled volumes
# hold random inert credentials; no token appears in argv, env or logs.
control_candidate="xynes-storage-control-$fixture_nonce"
secret_candidate="xynes-storage-secret-$fixture_nonce"
for volume in "$control_candidate" "$secret_candidate"; do
  if docker volume inspect "$volume" >/dev/null 2>&1; then
    echo "STORAGE_FIXTURE_VOLUME_ALREADY_EXISTS" >&2; exit 1
  fi
done
# Record only names proven absent before our labeled create intent.
control_volume=$control_candidate
secret_volume=$secret_candidate
for volume in "$control_volume" "$secret_volume"; do
  docker volume create --label "com.xynes.release-fixture=$fixture_nonce" "$volume" >/dev/null
done
init_container="xynes-storage-assets-$fixture_nonce"
docker run --rm --name "$init_container" --platform "$platform" --network none --read-only \
  --user 0:0 --cap-drop ALL --cap-add CHOWN --security-opt no-new-privileges \
  --memory 128m --pids-limit 32 --label "com.xynes.release-fixture=$fixture_nonce" \
  --env "STORAGE_RELEASE_FIXTURE_NONCE=$fixture_nonce" \
  --mount "type=volume,source=$control_volume,target=/run/xynes/storage-control,volume-nocopy" \
  --mount "type=volume,source=$secret_volume,target=/run/secrets,volume-nocopy" \
  --entrypoint bun "$image_tag" -e '
    const fs = require("node:fs"); const crypto = require("node:crypto");
    const control = "/run/xynes/storage-control"; const secrets = "/run/secrets";
    fs.chmodSync(control, 0o700); fs.chownSync(control, 1001, 1001);
    const token = secrets + "/storage-quiesce-token";
    fs.writeFileSync(token, crypto.randomBytes(32).toString("hex"), { flag: "wx", mode: 0o400 });
    fs.chownSync(token, 1001, 1001);
    fs.writeFileSync(secrets + "/fixture-nonce", process.env.STORAGE_RELEASE_FIXTURE_NONCE, { flag: "wx", mode: 0o444 });
    fs.chmodSync(secrets, 0o555);
  '
init_container=""
smoke_container=$(docker create --platform "$platform" --network none --read-only \
  --name "xynes-storage-entrypoint-$fixture_nonce" --user 1001:1001 \
  --cap-drop ALL --security-opt no-new-privileges --memory 1g --cpus 2 --pids-limit 128 \
  --label "com.xynes.release-fixture=$fixture_nonce" \
  --tmpfs /tmp:rw,noexec,nosuid,size=256m,mode=1777 \
  --mount "type=volume,source=$control_volume,target=/run/xynes/storage-control,volume-nocopy" \
  --mount "type=volume,source=$secret_volume,target=/run/secrets,readonly,volume-nocopy" \
  --mount "type=bind,source=$repo_dir/tests,target=/app/tests,readonly" \
  --env DATABASE_URL=postgres://fixture:fixture@127.0.0.1:1/sec005_fixture \
  --env STORAGE_PROCESSOR_MODE=live --env STORAGE_QUIESCENCE_ENABLED=1 \
  --env STORAGE_RELEASE_ENTRYPOINT_TEST=1 --env "STORAGE_RELEASE_FIXTURE_NONCE=$fixture_nonce" "$image_tag")
docker start "$smoke_container" >/dev/null
docker exec "$smoke_container" bun test --timeout 10000 tests/security/release-image.test.ts
cleanup_owned_container "$smoke_container"
smoke_container=""
