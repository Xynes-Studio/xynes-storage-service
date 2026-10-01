# Pre-PR Re-validation Report

## PR #33 merge resolution — 2026-10-01

Merged `develop` at `8167da2cd15909d1846a9d3f44c0836a0b596fa6` (SEC-001 PR #32)
into SEC-002. Resolved four conflicts in CI, upload completion, S3 adapter and
runner integration fixtures. Both SEC-001 CI jobs and archive-safety remain;
archive-safety now requires the combined quarantine gate.

Completion retains immutable copy/atomic finalization, checks staging and copied
source lengths before acceptance, recovers only typed missing multipart handles,
and preserves ownership-aware cleanup. A harmless SDK fixture replaces 4 staging
bytes with 5 during copy and verifies rejection before finalization/enqueue.
Two new copied-source length tests failed before the integration fix and pass now.
S3 CopyObject and independently bounded streaming reads coexist.

Validation: configured coverage gate **1,710 passed, 18 skipped, zero failures**;
**93.11% functions / 94.54% lines**. Changed production completion is **100% functions /
94.38% lines** and S3 adapter **100% / 100%**. Lint and typecheck pass. Four inherited
formatting differences were normalized to the locked formatter to keep lint green.
Real pinned scanner harness passes six archive tests and both SEC-001 delivery/native
rejection tests on the complete merged tree. Frozen daemon was reaped after client
disconnect in **1.108s** with the deliberately low watchdog. Scanner code/image
unchanged; the harness reused the previously built pinned test image.

Optional real MinIO/Postgres and unprovisioned processor suites remain skipped in
this local run; their existing CI jobs remain required. Loopback SDK multipart,
copy, HEAD, replay and bounded GET tests run locally. No real database, provider,
deployment or GitHub PR merge was performed. Main-checkout health edits are preserved.
This addendum supersedes the historical missing-SEC-001 merge blocker below.

## Historical verdict

> This report preserves the initial pre-publication review. The publication
> addendum below records the subsequent user authorization and PR32 gate evidence.

**NOT READY** for the combined SEC-002 PR. Byte-size reconciliation and archive
inspection controls are implemented and locally validated. SEC-001 is still being
developed on another computer. Its download/native scan-success gates are absent
here, and both combined consumer integration tests fail. No commit, push, merge,
deployment or PR has been performed.

## Branch and Base

- Storage branch: `feature/XYN-SEC-002-upload-size-enforcement`.
- Storage base: `develop`, `47c35e796f8e20636bdbe5adcb656f1d8125cf62`.
- Infra branch: `feature/XYN-SEC-002-archive-inspection`.
- Infra base: `develop`, `0beaa6a9dc965316184068d16e89daa52be5d194`.
- No staged changes or branch commits beyond these bases. Work is unstaged/untracked.
- Review date: 2026-10-01. Exact scope is in [the scope manifest](XYN-SEC-002-scope.md).

## Story Re-validation

| Requirement | Evidence / status |
| --- | --- |
| Actual upload length and bounded provider reads | Both completion methods HEAD and reconcile; all six runners and streamed S3 reads retain independent bounds |
| Compressed / expanded / member / depth / count / time budgets | Explicit 64 MiB / 128 MiB / 64 MiB / 5 / 512 / 5s engine + 10s hard wall policy |
| Canonical deployment and pinned effective config | Compose/K8s parity; pinned ClamAV 1.5.2 immutable base; actual `clamconf` output verified |
| Fail closed on incomplete/limits | Strict archive preflight, strict clean response parser, encrypted/unsupported rejection and terminal job outcomes |
| Deterministic failures avoid retries | Real scanner + runner + worker: required scan failed, parent failed, no retry and no subsequent attempt |
| Scanner-side termination | Frozen owned daemon killed/reaped after 50ms client disconnect; bounded restart accepts subsequent ordinary ZIP |
| Download/native quarantine gates | **Pending SEC-001**; both tests fail on this checkout after real archive rejection |
| Harmless fixtures, meaningful tests, TDD | Tiny ZIP fixtures plus generated TAR/GZIP/PAX cases; observed red tests before corresponding fixes |
| Quality / coverage / docs | Local and isolated gates pass; per-file production evidence below; policy/recovery/deployment limitations documented |

A 64 MiB scanner ceiling applies to every MIME type. Historical video/document/
other upload caps may be larger, but such objects cannot pass scanning. This
product limitation is explicit in the archive policy and API docs. Supported
preflight formats are ZIP, TAR and GZIP; detected unsupported formats are rejected.

## Git Changes Reviewed

The scoped detached snapshot at `/private/tmp/xyn-sec-002-pr-review` contains
SEC-002 changes only. Four adopted formatting-only lint prerequisites remain in
scope: objects/types, uploads/types, providers/secret-manager and tests/composition.
Security additions to DEVELOPER and deployment-posture were separated from their
pre-existing health hunks. The original health code diffs were compared exactly
against the pre-task patch and are unchanged. Infra smoke diffs remain unrelated.

Review included current status, staged diff, branch/base diff, branch log and all
scoped source/test/config/docs. No migrations, credentials or generated binaries
were added. The scope manifest identifies exclusions; the full working tree must
not be indiscriminately staged into a future PR.

## Architecture and Code Quality

Business length checks remain in action handlers and narrow processing IO ports;
provider streaming stays in the adapter. Archive validation and native process
ownership live in a dedicated sidecar, matching existing sidecar organization.
The new Go module uses only the standard library. No duplicate SEC-001 consumer
gates were introduced. The validator is intentionally conservative and bounded;
ClamAV alone cannot establish complete archive inspection.

There is no broad service rewrite, database change or new application dependency.
The custom scanner is a coordinated protocol/image change: raw clamd is not a
compatible production endpoint for the metadata-bearing Storage client.

## Testing and Coverage

| Gate | Final evidence |
| --- | --- |
| Isolated scoped Bun configured coverage run | **1,627 pass, 12 skip, 0 fail**, 90 files; **93.19% functions / 94.49% lines** |
| Scoped lint / TypeScript / bundle | All exit 0; 762 modules, 2.26 MB bundle |
| Working checkout coverage | **1,639 pass, 12 skip, 0 fail**; **91.82% functions / 93.39% lines** |
| Go race tests, local Go 1.24.1 | Pass; **87.3% statements** |
| Go race tests, exact Go 1.27.1 builder container | Pass; **87.6% statements** |
| Pinned real scanner harness | Pass; effective production config, raw-engine behavior, supervisor limits, real worker quarantine and watchdog recovery |
| Real scan + worker integration | **6 pass, 0 fail**, 31 assertions |
| Combined SEC-001 consumer gate | **0 pass, 2 fail**; expected dependency failures, separately recorded |
| Canonical infra affected checks | Both archive parity and existing deployment checks pass |
| Broader infra script suite | Stops in `feature-flags.test.sh`: local gateway unavailable at localhost:4100 |
| Compose / Kubernetes draft / CI YAML | Compose merged config passes; YAML parses and static parity passes; no cluster rollout or server-side schema certification |

Per-file evidence for substantive changed production code:

| File / group | Functions | Lines / statements |
| --- | --- | --- |
| byte-size-policy.ts | 100% | 100% |
| read-object.ts | 100% | 100% |
| scan-validation.ts | 100% | 100% |
| document.ts, image.ts, video.ts, profiles.ts, runner errors.ts | 100% each | 100% each |
| uploads/complete.ts | 100% | 99.27% |
| uploads/schemas.ts | 100% | 100% |
| provider-io.ts, bounded-body.ts, provider errors.ts, s3-adapter.ts | 100% each | 100% each |
| clamav-scanner.ts | 88.64% | 96.10% |
| archive-scanner/archive.go, pinned Go toolchain | statement metric | 95.08% |
| archive-scanner/server.go, pinned Go toolchain | statement metric | 84.21% |

Type-only contracts have no executable coverage. Test/validation harnesses are
exercised by their real integration runs. Both configured Bun thresholds and the
new per-file Go >=80% gate pass. Optional DB/LibreOffice and absent SEC-001 cases
are explicitly skipped in the ordinary suite; skips do not certify those paths.
The fixture DB URL is an unreachable synthetic loopback endpoint; no real DB is
seeded or changed. Live provider credentials/permissions remain unverified.

Raw pinned-engine tests reproduce MaxFiles, MaxRecursion, MaxScanSize and
MaxScanTime alerts. MaxFileSize alone returns clean for a 32 KiB ZIP member under
a 16 KiB test cap; preflight rejects it. StreamMaxLength, strict incomplete checks,
CRC, forged directory counts, member/depth/global inflation bounds and a valid
two-byte GNU PAX sparse member are covered. No resource-exhausting bomb was run.
The frozen daemon watchdog reaped the old PID ~0.755s after test start, despite
client disconnection at 50ms; the low hard wall setting was 500ms. PID inspection,
Docker command latency and scheduling add margin; this is not a production latency
benchmark. All owned test containers were removed.

## TypeScript Type-Check Review

Strict TypeScript, Hono, Zod, AWS SDK v3 and Drizzle are the actual service stack.
`bun run typecheck` passes in both working and isolated scope. No compiler settings
were relaxed, no new suppression directives were added and no avoidable unsafe
casts were introduced. Review removed SDK error-name/presigner/conditional-PUT
casts with proper narrowing/types. Three pre-existing S3 storage-class `as never`
casts remain outside the read/size path; provider configuration typing is a
separate low-priority follow-up, not a newly introduced bypass.

## Security Review

Independent read-only review found issues that were fixed with regression tests:
ZIP directory count allocation before bounds, declared MIME parameter bypass,
legacy TAR / nested tgz recognition, failed daemon state/restart, cancellation of
private socket IO, and GNU PAX sparse handling. ClamAV output is accepted as clean
only for the exact clean response. Socket writes observe backpressure; early
terminal responses and stalled writes are bounded. No user names become shell
commands or extraction paths. Original temp names are random and removed; member
bytes are never extracted to files. Payloads/signatures/transport details are not
logged or returned as public error text. Scanner runs non-root with private daemon,
read-only root/definitions, dropped capabilities and RAM/CPU/tmpfs caps.

The remaining release-level security concern is the absent SEC-001 consumer gate.
This has direct failing integration evidence and is not treated as a minor issue.

## Database and Migration Review

Drizzle repository contracts remain unchanged. No migration/schema/destructive
SQL, real database writes or data assumptions were introduced. Quarantined provider
objects are retained for audited operator cleanup; no deletion is performed.

## Documentation Review

Workspace/AGENTS guidance was followed. Developer defaults and scanning behavior,
API caps, README, module README, implementation plan, recovery policy, deployment
posture, Kubernetes draft notes and the dated audit addendum are updated. The old
verification record is explicitly historical. No changelog/release publication is
claimed. The sidecar architecture and safety budgets are documented in the policy.

## Commands Run

Principal verification commands (all paths are scoped to the respective repository):

```sh
# Storage: configured gate with unreachable fixture database; PASS
XYNES_ENV_FILE=/private/tmp/xyn-sec-002/test.env bun run test:coverage
# Isolated SEC-002 snapshot: same command; PASS 1627 / 12 skip / 0 fail
bun run lint                    # PASS
bun run typecheck               # PASS
bun build src/index.ts --target=bun --outdir=/private/tmp/xyn-sec-002/archive-scoped-build
# PASS
# Go: local race/coverage and per-file gate; PASS
go test -race -coverprofile=/private/tmp/xyn-sec-002/archive-go.cover ./...
python3 coverage-gate.py /private/tmp/xyn-sec-002/archive-go.cover
# Exact Go1.27.1 container: offline race/coverage; PASS
# Pinned image build and actual ClamAV harness; PASS
python3 scripts/test-archive-scanner.py
# Deliberately required SEC-001 combined gate; FAIL 2 missing gates
ARCHIVE_TEST_SKIP_BUILD=1 XYNES_SEC001_GATES_REQUIRED=1 python3 scripts/test-archive-scanner.py
# Infra: PASS affected static checks
bash scripts/test/storage-fu-5-fu-e-deployment-posture.test.sh
bash scripts/test/storage-sec-002-archive-policy.test.sh
# Infra broad suite: unrelated gateway prerequisite failure
bash scripts/test/run.sh
# Infra canonical Compose merge: PASS, no service start
docker compose --env-file .env.example -f docker-compose.dev.yml -f infra/compose/storage-live-processors.yml config --format json
# Ruby YAML parsing for draft Deployment and CI: PASS
# Both repos / isolated snapshot: PASS
git diff --check
```

Targeted TDD runs observed failures before fixes for archive budget, strict parser,
input cap, framing, child/daemon deadline, early terminal response, MIME parameter,
cancellation and PAX sparse regressions. Those targeted suites subsequently passed.
Logs and raw coverage profiles are retained under `/private/tmp/xyn-sec-002/`,
including archive-harness-final.log, archive-sec001-merge-gate-final.log,
archive-scoped-coverage-final.log, archive-go-pinned.log and archive-infra-suite.log.
Git status/staged/base/log inspection confirms no commits or staged scope.

## Fixes Made During Re-validation

Review fixes are listed in Security Review. Earlier byte-size review also removed
redundant worker cap checks and typed fake/provider fixtures. Final impacted,
full, lint, typecheck, coverage and Docker gates pass apart from the explicitly
required absent SEC-001 gates and unrelated local-gateway infra prerequisite.

## Suggested Commit Messages

Suggestions only; no commits were created:

- `fix(storage): reconcile upload bytes and bound archive inspection`
- `test(storage): verify pinned archive limits and quarantine integration`
- `fix(infra): configure supervised bounded archive scanning`
- `docs: record SEC-002 policy and SEC-001 integration requirement`

## Blocking Issues

Integrate SEC-001 from the other computer and require
`XYNES_SEC001_GATES_REQUIRED=1 python3 scripts/test-archive-scanner.py` to pass both
signed-download and actual native-runner checks. Current code still signs a failed
archive and reaches the image probe for a disguised rejected ZIP. Do not raise
this combined remediation PR until those gates pass.

## Recommended Follow-up Stories

- Publish the custom image and pin its registry digest for hosted/Kubernetes rollout;
  validate signature freshness, PVC permissions, startup and schema against the
  target deployment. Kubernetes remains an undeployed draft.
- Certify real R2/B2/MinIO multipart/HEAD behavior with controlled provider fixtures.
- Define audited retention cleanup for rejected finalized provider bytes.
- If large-file support is needed, design bounded large-file scanning separately;
  the current policy rejects scan inputs beyond 64 MiB.
- Tighten pre-existing provider storage-class configuration types separately.

## Final Notes

Independent SEC-002 implementation can proceed without merging SEC-001 first.
Combined PR readiness requires its gates and successful integration evidence.
Unrelated local work and the other computer's changes have not been overwritten.

## Draft publication addendum (2026-10-01)

The user explicitly requested raising the PR. Publish the independent storage
and infra changes as **drafts**, with merge blocked on SEC-001 integration.
SEC-001 is now published as [storage PR32](https://github.com/Xynes-Studio/xynes-storage-service/pull/32),
head `00e8124ca8fa4c5d39e5bca8c9ab1909cc9333ae`.

Fresh scoped verification passed: 1,627 tests / 12 skipped / 0 failures;
93.19% functions / 94.49% lines; lint and typecheck exit0. Go race/per-file gate
passed (archive95.08%, supervisor83.66% on local Go1.24.1). A separate isolated
snapshot overlaid the unmodified PR32 worker/download/scan-state/finalized-source
files, related type declarations and its finalized-object processing fake.
The real pinned scanner harness passed **6 archive tests plus 2 consumer gate
tests**, and the frozen daemon was reaped ~0.738s after test start. This certifies
the archive rejection's effect on PR32's existing gates; it **does not certify a
full branch merge or immutable upload finalization**. Evidence:
`/private/tmp/xyn-sec-002/pr-sec001-gates.log`.

Before marking the drafts ready, resolve upload completion using SEC-001's
immutable-copy/atomic-finalization structure. HEAD the **copied finalized key**
and enforce actual length before `finalizeIfPending`; a staging HEAD alone leaves
a replay window. Preserve typed multipart recovery, server-only keys, ownership-aware
cleanup, scan-source proof and both CI suites. Upgrade the S3 fixture to per-key
staging/finalized objects with explicit CopyObject and validate replay between
staging HEAD and copy, acceptance/mismatch before CAS and no enqueue on rejection.
Re-run the full combined provider/worker/download suite.

Affected infra scripts pass ShellCheck and their tests. Full `scripts/lint.sh`
fails on five pre-existing warnings in cleanup-universal-storage, smoke-api-key-
enforcement, smoke-cms-api-key, smoke-universal-storage and canonical-reset-smoke.
The broader script suite retains its unrelated unavailable-gateway prerequisite.
No unrelated health/smoke work is included. Deployment remains unauthorized.
