#!/usr/bin/env bash
# Disposable loopback fixtures only. Does not use app containers, env or DB.
set -euo pipefail
repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
fixture_dir=$(mktemp -d)
db_name="sec001-fixture-$(basename "$fixture_dir" | tr '[:upper:]' '[:lower:]')"
minio_pid=''
cleanup() {
  if [[ -n "$minio_pid" ]]; then kill "$minio_pid" 2>/dev/null || true; wait "$minio_pid" 2>/dev/null || true; fi
  docker rm -f -v "$db_name" >/dev/null 2>&1 || true
  rm -rf -- "$fixture_dir"
}
trap cleanup EXIT

minio_version=v0.0.0-20251015172955-9e49d5e7a648
minio_binary=${SEC001_MINIO_BINARY:-"$fixture_dir/bin/minio"}
if [[ -z "${SEC001_MINIO_BINARY:-}" ]]; then
  GOBIN="$fixture_dir/bin" go install "github.com/minio/minio@$minio_version"
fi
go version -m "$minio_binary" | awk -v expected="$minio_version" '
  $1 == "mod" && $2 == "github.com/minio/minio" && $3 == expected { found = 1 }
  END { exit !found }
'

# Select unused loopback ports; the readiness checks reject startup failures.
ports=$(bun -e 'const a=Bun.serve({hostname:"127.0.0.1",port:0,fetch(){return new Response()}});const b=Bun.serve({hostname:"127.0.0.1",port:0,fetch(){return new Response()}}); console.log(a.port,b.port);a.stop(true);b.stop(true)')
read -r minio_port console_port <<< "$ports"
MINIO_ROOT_USER=fixture-admin MINIO_ROOT_PASSWORD=fixture-only-local-password \
  "$minio_binary" server "$fixture_dir/data" --address "127.0.0.1:$minio_port" \
  --console-address "127.0.0.1:$console_port" > "$fixture_dir/minio.log" 2>&1 &
minio_pid=$!
export SEC001_ISOLATED_PROVIDER_URL="http://127.0.0.1:$minio_port"
bun -e 'for(let i=0;i<60;i++){try{if((await fetch(process.env.SEC001_ISOLATED_PROVIDER_URL+"/minio/health/live")).ok)process.exit(0)}catch{} await Bun.sleep(500)}throw new Error("Isolated provider startup failed")'

docker run --rm -d --name "$db_name" --memory 512m --cpus 1 \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=sec001_fixture \
  -p 127.0.0.1::5432 \
  postgres@sha256:f1c3376c26f2609ab9f29f71f824103fe2fcd8ee0346485cb6122a4f93df6f94 >/dev/null
db_port=$(docker port "$db_name" 5432/tcp)
db_port=${db_port##*:}
db_ready=0
for ((i=0;i<60;i++)); do
  # The image's temporary init server accepts socket connections before it
  # shuts down. TCP readiness waits for the final server used by the tests.
  if docker exec "$db_name" pg_isready -h 127.0.0.1 -U postgres -d sec001_fixture >/dev/null; then db_ready=1; break; fi
  sleep 0.5
done
if [[ "$db_ready" != 1 ]]; then
  echo 'Isolated Postgres startup failed' >&2
  exit 1
fi
docker exec -i "$db_name" psql -h 127.0.0.1 -U postgres -d sec001_fixture -v ON_ERROR_STOP=1 \
  < "$repo_dir/tests/integration/immutable-source/schema.sql" >/dev/null
export SEC001_ISOLATED_DB_URL="postgres://postgres@127.0.0.1:$db_port/sec001_fixture"
export STORAGE_INTEGRATION_DB_URL="$SEC001_ISOLATED_DB_URL"
export STORAGE_INTEGRATION_DB_REQUIRED=1
cd -- "$repo_dir"
bun run scripts/test-coverage-gate.ts
