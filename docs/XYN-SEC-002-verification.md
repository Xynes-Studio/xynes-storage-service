# XYN-SEC-002 — initial byte-size implementation and verification

> Historical byte-size phase (2026-09-30). The archive extension adds scanner
> policy environment values, a Go sidecar and new review fixes. Current combined
> scope and gates are in [the pre-PR report](XYN-SEC-002-pre-pr-review.md) and
> [archive policy](XYN-SEC-002-archive-policy.md).

The initial local code fix validates actual provider object length before upload completion
and bounds downloads before every scanner/native processor. This record accompanies
[the original audit finding](../../xynes-infra/infra/release/SECURITY-AUDIT-2026-09-30.md#xyn-sec-002--uploaded-object-length-is-not-reconciled-with-declared-size-before-processing).
The dated audit is preserved; this is code remediation evidence, not a production
release signoff or live-provider certification.

## Scope and branch

- Date: 2026-09-30.
- Repository: `xynes/xynes-storage-service`.
- Branch: `feature/XYN-SEC-002-upload-size-enforcement`.
- Base commit: `47c35e796f8e20636bdbe5adcb656f1d8125cf62`.
- Changes remain local and uncommitted. No push, PR, merge, or deployment.
- Existing health/readiness work was present on `fix/local-regression-health-contract`.
  It remains in the working tree. Its tracked diffs were compared byte-for-byte
  against the pre-task snapshot; only `DEVELOPER.md` also gained an appended section.
- No schema/migration changes or real database writes. No new dependencies,
  credentials, env variables, permission changes, or relaxed compiler settings.

## Resulting behavior

- Both upload methods HEAD the provider object before state transitions or jobs.
  Actual length must be a positive safe integer exactly equal to stored `byteSize`
  and within the existing family policy (image 50 MiB, video 2 GiB, document
  100 MiB, other 5 GiB). Exact boundaries remain accepted.
- Invalid completion aborts a pending session, leaves its object `pending_upload`,
  does not enqueue, and returns `400 VALIDATION_ERROR` with safe static text.
- HEAD outages leave the session pending. A retry after successful provider
  finalization may recover a missing multipart handle only through mandatory HEAD
  validation. Other multipart errors still propagate.
- All six runners validate stored length, pass read bounds through the provider IO
  port, and check returned bytes before scanning/probing/rendering. Size failures
  are non-retryable; transient I/O remains retryable.
- S3 downloads count actual chunks independently of GET metadata and cancel or
  destroy rejected responses. A growing buffer avoids retaining arbitrary numbers
  of tiny/empty chunks. No whole-response conversion API is used.
- New read code has no `any`, unsafe cast, suppression directive, or broad lint
  disable. Scoped casts in the former whole-body reader and SDK error-name access
  were removed. Pre-existing S3 storage-class `as never` casts remain outside the read/size
  paths; changing provider configuration is deferred. Pre-PR review removed the
  conditional-PUT double cast and presigner assertions using SDK types. Existing tsconfig strictness and
  skipLibCheck configuration are unchanged.

## Test-first evidence and final gates

Baseline: **1524 pass, 9 skip, 0 fail**, lint/typecheck clean before task edits.

New regressions failed before fixes: completion (20 failures), streamed bounds
(12 failures), all-runner input integrity (21 failures), response disposal (1),
SDK name redaction (1), multipart retry recovery (3). Each corresponding targeted
suite passed after its fix. Later boundary cases expand these groups.

Final verification used Bun **1.2.18**, matching CI. The fixture env at
`/private/tmp/xyn-sec-002/test.env` points `STORAGE_INTEGRATION_DB_URL` to an
unreachable synthetic loopback endpoint, preventing real DB fixture seeding.
Loopback HTTP tests were run with the permission needed to bind a temporary
local server; no hosted providers were called.

| Command | Result |
| --- | --- |
| `XYNES_ENV_FILE=/private/tmp/xyn-sec-002/test.env bun run test` | **1614 pass, 9 skip, 0 fail**, 90 files; +90 passing tests vs baseline |
| `XYNES_ENV_FILE=/private/tmp/xyn-sec-002/test.env bun run test:coverage` | Pass: **91.81% functions / 93.38% lines**, above the 80% gate |
| `bun run lint` | Pass, exit 0 |
| `bun run typecheck` | Pass, exit 0; no new type debt |
| `bun build src/index.ts --target=bun --outdir=/private/tmp/xyn-sec-002/build` | Pass: 777 modules, 2.25 MB bundle; repo has no build script |
| `git diff --check` | Pass |

New policy, shared worker reader, bounded response reader, and S3 adapter each
report **100% functions / 100% lines**; completion reports 100% functions /
99.27% lines. Database/native-sidecar optional coverage is not certified by these
unit results.

The real-SDK loopback fixture performs multipart initiation, presigned part PUT,
completion, HEAD reconciliation, and a chunked GET. Declared=4 with actual=3/5
is rejected; actual=4 succeeds. Replacing that completed object with 5 bytes is
rejected before the image decoder. It does not validate provider authentication
or a deployed R2/B2/MinIO configuration.

## Independent review

The requesting-code-review skill directed a read-only reviewer. No actionable
correctness/security findings were reported. The reviewer independently passed
176 targeted unit tests; its protocol tests could not bind a loopback listener in
the restricted sandbox. The primary run exercised all three protocol cases with
the required local-listener permission, as part of the successful full suite.

## Operational limits and follow-ups

- Rejected finalized provider objects are retained. The existing abandoned-session
  job only expires pending sessions; operator retention/cleanup must remove rejected
  provider bytes after confirming ownership and session state.
- Input retention is bounded by declaration/policy. It is not a total-process RSS
  guarantee: buffer growth, native processors, and worker concurrency consume
  additional memory. Existing video/other caps require deployment capacity planning.
- Completed-session idempotency is preserved without re-HEAD. Workers independently
  validate bytes, including legacy rows and replaced provider objects.
- Live R2/B2/MinIO multipart/HEAD checks, an isolated backed-up database suite, and
  Linux release-image evidence remain operator follow-ups. Other audit findings,
  including the native-decoder release blocker XYN-SEC-001, remain separate work.

## Files changed for this finding

- `DEVELOPER.md (appended XYN-SEC-002 section only)`
- `docs/XYN-SEC-002-verification.md (this record)`
- `docs/api-contract.md`
- `docs/plans/2026-09-30-XYN-SEC-002-upload-size-enforcement.md`
- `src/actions/handlers/objects/byte-size-policy.ts`
- `src/actions/handlers/processing/runners/document.ts`
- `src/actions/handlers/processing/runners/image.ts`
- `src/actions/handlers/processing/runners/ports.ts`
- `src/actions/handlers/processing/runners/profiles.ts`
- `src/actions/handlers/processing/runners/read-object.ts`
- `src/actions/handlers/processing/runners/scan-validation.ts`
- `src/actions/handlers/processing/runners/video.ts`
- `src/actions/handlers/uploads/complete.ts`
- `src/actions/handlers/uploads/schemas.ts`
- `src/infra/processors/provider-io.ts`
- `src/infra/providers/bounded-body.ts`
- `src/infra/providers/errors.ts`
- `src/infra/providers/s3-adapter.ts`
- `src/infra/providers/types.ts`
- `tests/actions/handlers/processing/complete-wiring.test.ts`
- `tests/actions/handlers/processing/runners/document.test.ts`
- `tests/actions/handlers/processing/runners/image.test.ts`
- `tests/actions/handlers/processing/runners/integration.test.ts`
- `tests/actions/handlers/processing/runners/registry.test.ts`
- `tests/actions/handlers/processing/runners/scan-validation.test.ts`
- `tests/actions/handlers/processing/runners/size-enforcement.test.ts`
- `tests/actions/handlers/processing/runners/video.test.ts`
- `tests/actions/handlers/uploads/complete.test.ts`
- `tests/actions/handlers/uploads/dispatch.test.ts`
- `tests/infra/processors/provider-io.test.ts`
- `tests/infra/processors/runner-dependencies.test.ts`
- `tests/integration/provider-size.integration.test.ts`
- `tests/providers/errors.test.ts`
- `tests/providers/s3-adapter.test.ts`


## Pre-PR re-validation

The later review checks a detached `develop` snapshot with only this finding's
changes, excluding unrelated health/readiness behavior. Four pre-existing
formatting-only corrections (`objects/types.ts`, `uploads/types.ts`,
`providers/secret-manager.ts`, `tests/composition.test.ts`) are explicitly
included as lint prerequisites; they introduce no behavior changes.
The reviewer also removed avoidable SDK/presigner casts and redundant worker
cap checks, updated their typed fixture, and linked this contract from README.
See [the pre-PR report](XYN-SEC-002-pre-pr-review.md) for fresh gates, exact PR
scope, exclusions, and remaining type/deployment evidence gaps.

## Current archive extension gates (2026-10-01)

The final working checkout passes **1,639 tests, 12 skipped, 0 failures**, with
**91.82% functions / 93.39% lines** under the configured coverage gate. The isolated
SEC-002 snapshot passes **1,627 tests, 12 skipped, 0 failures**, with **93.19% /
94.49%** coverage. Lint, typecheck and bundle pass. Pinned Go1.27.1 race/coverage
passes (87.6% overall statements; archive.go95.08%, server.go84.21%). The real
pinned scanner harness passes and cleans its test containers.

Both explicitly required SEC-001 consumer gates currently fail because that
implementation is on another computer. The verdict remains **NOT READY** until
combined signed-download and native-runner integration passes. See the
[complete current report](XYN-SEC-002-pre-pr-review.md) for fixes, per-file evidence,
exact scope and deployment limitations. The earlier sections are historical.


Draft publication is now user-authorized. SEC-001 PR32's unmodified gates were
validated in a separate overlay snapshot: 6 archive tests and both consumer gate
tests pass with the pinned engine. Full completion/finalized-key merge validation
remains pending; see the publication addendum in the report.
