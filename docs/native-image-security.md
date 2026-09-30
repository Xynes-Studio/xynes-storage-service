# Native image security — XYN-SEC-001

## Decoder remediation

Sharp is pinned to 0.35.5 with its platform packages in `bun.lock`. This release
bundles libheif 1.23.5 and libvips 8.18.7. These replace the vulnerable versions
in the September 30 audit, including upstream fixes released since that audit's
original advisory thresholds. References:

- [Sharp libheif advisory](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c)
- [Sharp libvips advisory](https://github.com/lovell/sharp/security/advisories/GHSA-f88m-g3jw-g9cj)
- [Sharp 0.35.5](https://github.com/lovell/sharp/releases/tag/v0.35.5)
- [Bundled native versions](https://github.com/lovell/sharp-libvips/releases/tag/v1.3.4)

`assertSafeNativeImageRuntime` checks loaded Sharp/libheif/libvips versions
before any Sharp metadata or pixel decoding. Older, missing, non-numeric and
prerelease versions fail closed. The existing live lazy loader catches that
failure and uses the non-decoding production stub. Stub mode does not load Sharp.
Custom/global native builds must also meet the floor. Future upgrades require a
fresh advisory review; a version floor is not a universal vulnerability scan.

JPEG, PNG, WebP and AVIF support is preserved. The bundled build reads HEIC
metadata but does not ship HEVC pixel decoding; that existing rendering failure
is tested with a harmless HEIC fixture. No new HEIC rendering support is claimed.

## Scan quarantine

SEC-001-FU-1 closes scan/content identity within this PR. Upload URLs target
staging. Completion makes a fresh server-only same-bucket snapshot, then atomically
binds it to the object and completed session. Scan success persists that exact
source key/provider in server-owned job JSON. Workers and signed downloads require
matching evidence and a finalized key. Same-length staging replacement and URL
replay cannot mutate an accepted source, including after GET URL creation.

Native processing and signed downloads require persisted successful required
`scan_validation` jobs for the same object, queried within its workspace.
Scan jobs run first within a claimed batch; every non-scan runner independently
checks persisted evidence so a scan running in another worker cannot permit
decoding. Queued/running scans release the native claim for a later poll without
consuming an attempt. Missing, failed, cancelled, optional or conflicting scan
evidence fails the native job with `SCAN_NOT_PASSED` and marks the object failed.
Scan-state lookup failure retries with `SCAN_STATE_UNAVAILABLE` without decoding.

Download requests check the same evidence before credential resolution or URL
signing. They fail with a generic validation error while evidence is unavailable,
even for an object marked ready. A clean original remains downloadable if a
different processing job fails. Unknown or infected scanner verdicts and scanner
outages never produce variants or signed downloads. Resolve scanner availability
or the rejected upload, then use the existing processing retry action to rescan;
do not backfill success without scanning. Legacy objects and unbound proof also fail closed. Retry only requeues existing
failed jobs; it cannot upgrade legacy proof or repair missing/cancelled scans.
Response shapes and schema are unchanged. See [FU-1 design](plans/2026-09-30-XYN-SEC-001-FU-1-design.md).

## Legacy rollout and retention

Deploy only to private buckets. Disable old service instances before enabling new
upload/download handlers. Existing signed URLs are provider capabilities: this
code cannot revoke URLs already issued by an old version. Remove/quarantine legacy
provider keys (after approved retention/migration handling), or wait until every
legacy GET/upload URL expires before claiming enforced quarantine. Audit actual
configured TTLs, not defaults. Never allow old instances to keep issuing URLs.
Legacy objects require a new finalized upload and a successful scan; update owning
references through their normal APIs. Do not mark old successful scan rows as bound
or add a legacy-key fallback. If a provider lacks atomic independent CopyObject,
completion fails closed; verify each configured provider during rollout.

Successful completion deletes staging best-effort. Replayed upload URLs may recreate
staging, so expire `workspaces/*/uploads/v1/*` only after the longest upload/session
lifetime plus an operational margin. Losing CAS candidates are deleted best-effort.
Candidates left by uncertain DB commits must be retained until reconciliation
proves they are unreferenced by objects, jobs and variants. Never use blanket
expiry on `finalized/v1`; those keys hold accepted originals. Storage administrators
and service credentials must not rewrite those keys. Privileged provider/bucket
configuration changes and credential compromise are outside uploader replay proof.

Run `bash scripts/verify-immutable-source.sh` to build pinned official MinIO source,
create a disposable loopback Postgres fixture, verify signed single/multipart and
after-signing replay, database races/rollback/proof persistence, and the full coverage
gate. Go, Docker and Bun are required. CI runs this independently from the Linux
production-image check. No hosted credentials or application database are used.

## Linux artifact verification

Run in the storage repository:

```bash
bun install --frozen-lockfile
bun run test
bun run test:coverage
bun run lint
bun run typecheck
bash scripts/verify-release-image.sh local/xynes-storage:security-check linux/amd64
```

There is no package build script. The production Docker build is the release
build. `verify-release-image.sh` builds it, asserts the loaded native versions
and HEIF buffer loaders, then runs the native gate, safe image corpus and
upload-to-worker fixture tests and quarantine gates against its installed
dependencies and source.
Only the repository's tests are mounted read-only; no host `node_modules`,
provider credentials or database are used. Tests require AVIF support and fail
on absent/unsafe decoders. The negative runtime test proves unsafe native
versions select the non-decoding fallback without a malicious image.

The test container has no network, UID is nonzero, rootfs is read-only, all
capabilities are dropped, privilege escalation is disabled, memory is limited
to 1 GiB, CPU to two cores and PIDs to 128. ffmpeg's scratch space is a 256 MiB
`noexec,nosuid` tmpfs. A write to `/app` must fail. The workflow's
`release-image-security` job executes the same command on Linux x64.
Use `linux/arm64` as the second argument for an ARM release target and rerun
against the exact final release artifact. No deployment or release signoff is
performed by this command.

## Production Compose and least privilege

The production image installs dependencies inside Linux, copies only manifests,
runtime source and the native verification script, and runs as Bun's non-root
user. `Dockerfile.dockerignore` independently excludes host dependencies, local
env files and other workspace files; it does not modify a user's `.dockerignore`.

Append this repository's `compose.security.yml` **last** to the deployment's
Compose files. It requires [Compose ≥2.24.4](https://docs.docker.com/reference/compose-file/merge/)
for replacement tags. It selects `prod`, removes inherited source/dependency
mounts and overrides shared env injection. The new **operator-only** variable
`STORAGE_RUNTIME_ENV_FILE` must point to an ignored storage-only runtime env
file; relative paths are resolved from the first Compose file. No env secret
file is committed. Production starts `src/index.ts` directly and does not
load a local `.env.dev` file.

The file should contain only:

- `DATABASE_URL` for the storage DB role and the existing internal authentication
  settings (`INTERNAL_AUTH_MODE`, `INTERNAL_JWT_SIGNING_KEY`, or the configured
  legacy `INTERNAL_SERVICE_TOKEN`). Do not weaken the existing deployment mode.
- Only `STORAGE_CREDENTIAL_<PATH>_ACCESS_KEY_ID` and
  `STORAGE_CREDENTIAL_<PATH>_SECRET_ACCESS_KEY` pairs required by storage's
  `credential_ref` values. Do not inject sibling services' credentials or
  Supabase service-role keys.
- Required processor endpoint settings (`CLAMD_HOST`, `CLAMD_PORT`, optional
  `CLAMD_SOCKET`, `LIBREOFFICE_SERVICE_URL`) and existing storage timeout,
  concurrency, cleanup or logging settings needed by that deployment.

The overlay fixes `NODE_ENV=production`, `STORAGE_PROCESSOR_MODE=live` and the
configured storage port. It preserves the deployment's networks and sidecar
dependencies. It does not start, provision or replace the documented processor
sidecars. The resource limits are an initial safety budget; tune with a bounded
fixture load test before release. A job exceeding memory may terminate the
service process; resource limits do not promise graceful completion.

## Remaining boundaries

Sharp shares the API/worker address space and the storage credentials required
there. Non-root/read-only execution reduces system authority but cannot isolate
those credentials from a compromised native decoder. Separate worker identity
and narrower internal signing authority remain architectural follow-up.
XYN-SEC-002's actual upload length reconciliation is unchanged. No DB migration,
reset, production-data access or real provider upload is needed for this fix.

The original audit remains historical evidence; this change does not override
its release decision. Final deployment validation, backup/restore evidence and
the other audit findings still require their own acceptance.
