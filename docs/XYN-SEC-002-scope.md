# SEC-002 exact review scope

## Storage

71 files, including this manifest and the report. DEVELOPER and deployment-posture contain scoped changes alongside unrelated existing health hunks; include only the security hunks.

- `.github/workflows/ci.yml`
- `DEVELOPER.md`
- `README.md`
- `docs/XYN-SEC-002-archive-policy.md`
- `docs/XYN-SEC-002-pre-pr-review.md`
- `docs/XYN-SEC-002-scope.md`
- `docs/XYN-SEC-002-verification.md`
- `docs/api-contract.md`
- `docs/deployment-posture.md`
- `docs/plans/2026-09-30-XYN-SEC-002-upload-size-enforcement.md`
- `scripts/test-archive-scanner.py`
- `sidecars/archive-scanner/.gitignore`
- `sidecars/archive-scanner/Dockerfile`
- `sidecars/archive-scanner/README.md`
- `sidecars/archive-scanner/archive.go`
- `sidecars/archive-scanner/archive_test.go`
- `sidecars/archive-scanner/coverage-gate.py`
- `sidecars/archive-scanner/gateway_test.go`
- `sidecars/archive-scanner/go.mod`
- `sidecars/archive-scanner/more_test.go`
- `sidecars/archive-scanner/server.go`
- `sidecars/archive-scanner/server_test.go`
- `src/actions/handlers/objects/byte-size-policy.ts`
- `src/actions/handlers/objects/types.ts`
- `src/actions/handlers/processing/runners/document.ts`
- `src/actions/handlers/processing/runners/errors.ts`
- `src/actions/handlers/processing/runners/image.ts`
- `src/actions/handlers/processing/runners/ports.ts`
- `src/actions/handlers/processing/runners/profiles.ts`
- `src/actions/handlers/processing/runners/read-object.ts`
- `src/actions/handlers/processing/runners/scan-validation.ts`
- `src/actions/handlers/processing/runners/video.ts`
- `src/actions/handlers/uploads/complete.ts`
- `src/actions/handlers/uploads/schemas.ts`
- `src/actions/handlers/uploads/types.ts`
- `src/infra/processors/clamav-scanner.ts`
- `src/infra/processors/provider-io.ts`
- `src/infra/providers/bounded-body.ts`
- `src/infra/providers/errors.ts`
- `src/infra/providers/s3-adapter.ts`
- `src/infra/providers/secret-manager.ts`
- `src/infra/providers/types.ts`
- `tests/actions/handlers/processing/complete-wiring.test.ts`
- `tests/actions/handlers/processing/runners/document.test.ts`
- `tests/actions/handlers/processing/runners/errors.test.ts`
- `tests/actions/handlers/processing/runners/image.test.ts`
- `tests/actions/handlers/processing/runners/integration.test.ts`
- `tests/actions/handlers/processing/runners/registry.test.ts`
- `tests/actions/handlers/processing/runners/scan-validation.test.ts`
- `tests/actions/handlers/processing/runners/size-enforcement.test.ts`
- `tests/actions/handlers/processing/runners/video.test.ts`
- `tests/actions/handlers/uploads/complete.test.ts`
- `tests/actions/handlers/uploads/dispatch.test.ts`
- `tests/composition.test.ts`
- `tests/fixtures/archives/README.md`
- `tests/fixtures/archives/expanded-size.zip`
- `tests/fixtures/archives/incomplete.zip`
- `tests/fixtures/archives/member-size.zip`
- `tests/fixtures/archives/members.zip`
- `tests/fixtures/archives/nested.zip`
- `tests/fixtures/archives/ordinary.zip`
- `tests/fixtures/archives/time.zip`
- `tests/infra/processors/clamav-scanner.test.ts`
- `tests/infra/processors/provider-io.test.ts`
- `tests/infra/processors/runner-dependencies.test.ts`
- `tests/integration/processors/archive-sec001-gates.integration.test.ts`
- `tests/integration/processors/archive.integration.test.ts`
- `tests/integration/provider-size.integration.test.ts`
- `tests/providers/errors.test.ts`
- `tests/providers/multi-provider-matrix.test.ts`
- `tests/providers/s3-adapter.test.ts`

## Infra

- `infra/compose/storage-live-processors.yml`
- `infra/release/SECURITY-AUDIT-2026-09-30.md`
- `infra/release/deployment-posture/k8s/20-clamav-clamd.deployment.yaml`
- `infra/release/deployment-posture/k8s/README.md`
- `scripts/test/storage-fu-5-fu-e-deployment-posture.test.sh`
- `scripts/test/storage-sec-002-archive-policy.test.sh`

## Excluded existing work

Storage: root Dockerfile, package.json healthcheck script, app.ts, health.ts,
ready.ts, readiness.ts, app tests, Docker/health contract tests and existing health
hunks in DEVELOPER/deployment-posture. Original tracked code diffs are unchanged.
Four formatting-only prerequisites are explicitly included in the storage list.

Infra: smoke-all.sh, smoke-health.sh and their untracked contract tests. Original
tracked smoke diffs are unchanged. SEC-001 exists on another computer and is not
in this workspace or scope. No git stages/commits were made during the initial review; the user subsequently authorized scoped draft publication.

The detached review snapshot strips existing health hunks from the two shared
docs and uses baseline health code. Raw scope patches and snapshots are retained
under `/private/tmp/xyn-sec-002/`; they are evidence, not a committed release.
