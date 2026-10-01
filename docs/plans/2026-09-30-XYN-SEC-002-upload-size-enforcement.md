# XYN-SEC-002 Upload Size Enforcement Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent inconsistent or oversized provider objects from completing uploads or reaching processors.

**Architecture:** Reuse the current file-family caps for upload completion and worker input validation. All workers pass a byte limit and expected length through ProviderObjectIO; the S3 adapter consumes incremental chunks and cancels on overflow rather than using whole-body buffering helpers. No database migration, new dependency, or auth change is required.

**Tech Stack:** Bun, strict TypeScript, Hono, Zod, AWS SDK v3, Drizzle repositories, Bun test, ESLint.

---

### Task 1: Completion validation

- Test: `tests/actions/handlers/uploads/complete.test.ts` — single and multipart mismatch, invalid lengths, family caps, exact boundaries, provider HEAD failure, no enqueue on rejection.
- Run `bun test tests/actions/handlers/uploads/complete.test.ts` and verify new tests fail.
- Modify `src/actions/handlers/uploads/complete.ts` to HEAD both completed upload methods before any successful state transition; invalid objects abort the pending session. Leave provider bytes for existing cleanup rather than deleting data during a concurrent completion.
- Create `src/actions/handlers/objects/byte-size-policy.ts`; preserve existing constant exports in upload schemas and processing profiles.
- Re-run targeted tests. Update fixtures whose declared size did not match fake HEAD.

### Task 2: Bounded S3 reads

- Test: `tests/providers/s3-adapter.test.ts` — streamed overflow, misleading/missing ContentLength, exact boundary, cancellation, underflow, redaction, invalid read limits, Node and Web streams.
- Run the new tests and verify they fail before implementation.
- Add optional read bounds to `src/infra/providers/types.ts` and `src/actions/handlers/processing/runners/ports.ts`; forward them through `src/infra/processors/provider-io.ts`.
- Replace whole-response conversion in `src/infra/providers/s3-adapter.ts` with incremental consumption in `src/infra/providers/bounded-body.ts`. Introduce pre-redacted size error codes in `src/infra/providers/errors.ts`.
- Re-run adapter and provider IO tests.

### Task 3: Worker guards

- Test all six workers (scan, image, document, three video runners) against larger and smaller actual byte payloads; assert processor/scanner is never invoked and errors are non-retryable. Test cap failures before provider I/O.
- Run new regression tests before implementation.
- Create `src/actions/handlers/processing/runners/read-object.ts`; route each worker through it. Check returned lengths even when an injected IO implementation ignores bounds.
- Update successful existing worker fixtures to declare their actual bytes. Re-run runner tests.

### Task 4: Integration and verification

- Add a loopback S3 protocol fixture exercising real AWS SDK multipart completion, HEAD, and bounded GET without hosted credentials or database writes.
- Update `DEVELOPER.md`, `docs/api-contract.md`, and a task-specific verification document. Preserve the dated audit as original evidence.
- Run `XYNES_ENV_FILE=/private/tmp/xyn-sec-002/test.env bun run test`, `bun run test:coverage` with the same fixture env, `bun run lint`, `bun run typecheck`, and `bun build src/index.ts --target=bun --outdir=/private/tmp/xyn-sec-002/build` (no build script exists).
- Inspect coverage (functions and lines >=80%), scoped diff, type bypasses, and pre-existing work preservation. No push, PR, or merge.

## Baseline and scope

- Branch: `feature/XYN-SEC-002-upload-size-enforcement`, created from the current checkout, preserving the pre-existing health/readiness edits.
- Baseline: 1524 pass, 9 skip, 0 fail; lint/typecheck pass. Repository integration DB forced to an unreachable fixture address; no existing database is seeded or mutated.
- Docs reference ADR-001's 80% threshold; the storage repo has no local ADR-001 document. The workspace testing ADR and the repo's actual Bun coverage gate were reviewed.
- Live R2/B2/MinIO deployment evidence remains an operator follow-up; local protocol fixtures prove the adapter contract only.

## Archive extension (2026-09-30)

The pinned ClamAV 1.5.2 probe reports MaxFiles and MaxRecursion but silently
accepts a ZIP with a member larger than MaxFileSize. A dedicated scanner
supervisor therefore validates ZIP/TAR/GZIP bytes with bounded standard-library
readers, rejects unsupported/encrypted/malformed archives, and proxies only
validated input to a private clamd listener. It owns the daemon and kills/reaps
it on wall-time exhaustion; a client disconnect never certifies termination.

- Preserve SEC-001 on the other computer; do not edit download/worker gates here.
- Write failing Go validator, INSTREAM, deadline/reaping, and tiny archive tests.
- Implement the standard-library scanner supervisor under `sidecars/archive-scanner`.
- Write failing TS limit-response, strict clean-parser, input-cap and runner tests;
  add typed non-retryable archive/timeout outcomes without changing existing gates.
- Configure explicit ClamAV limits, scratch/queue limits and supervisor in canonical
  Compose and K8s draft; validate generated and effective config in the pinned image.
- Exercise harmless ZIP acceptance, nested/member/expanded limits, daemon deadline
  and client timeout; never use resource-exhausting fixtures.
- Run Bun gates, Go race/coverage, Docker build and deployment shape/config checks.
- Combined SEC-001 gate integration requires its uncommitted changes, currently on
  another computer; save a gate integration test to execute after its merge.
- No commit, push, PR, deployment or merge is authorized.

### Archive implementation status (2026-10-01)

- [x] Bounded validator, actual-length preservation, terminal outcomes and hard daemon watchdog.
- [x] Pinned-image effective configuration and harmless real-engine limit behavior verified.
- [x] Compose/K8s explicit compatible policy, least privilege, parity checks and archive CI job.
- [x] Race tests, >=80% changed-file coverage, scoped Bun gates and independent review fixes.
- [x] Ordinary ZIP, expanded/member/nesting, CRC/incomplete, PAX sparse, timeout and quarantine tests.
- [ ] Integrate SEC-001 from the other computer and pass both combined consumer gates.
- [ ] Operator release validation: custom image publication/digest, signature freshness and draft K8s rollout.

Both consumer tests currently fail as expected on pre-SEC-001 code. No PR should
be raised until the combined gate passes. See the final re-validation report.
