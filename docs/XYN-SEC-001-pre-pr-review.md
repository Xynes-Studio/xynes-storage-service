# Pre-PR Re-validation Report

Publication follow-up, 2026-10-01: the user subsequently authorized updating the
existing PR against `develop`. This commit includes the validated corrections
below; CI on the updated head is still required. The report records the review
state before that publication authorization.

## Verdict

**NOT READY for approval of the current published PR head.**

SEC-001 and SEC-001-FU-1 satisfy the reviewed implementation requirements locally.
The existing [PR #32](https://github.com/Xynes-Studio/xynes-storage-service/pull/32)
has a failed immutable-source CI gate. Small fixes were made and validated locally;
they have not been committed or pushed during this review. An updated PR head must
pass CI before approval. This supersedes the 2026-09-30 readiness verdict.

Review date: 2026-10-01. The attached story field was a placeholder; scope was
inferred from the conversation, original SEC-001 audit and completed FU-1 story.

## Branch and Base

- Current branch: `feature/XYN-SEC-001-patched-image-processing`.
- Freshly fetched comparison base: `origin/develop`, `47c35e796f8e20636bdbe5adcb656f1d8125cf62`.
- Published head: `031dc672a56a27883007b18241c0cc094b3bda31`, one commit above the base.
- Review scope: all 64 branch-diff files, staged/unstaged state, tests, binary fixtures,
  configuration, lockfile, SQL fixture and documentation. No staged changes existed.

## Story Re-validation

| Requirement | Result |
| --- | --- |
| Patched loaded Sharp/native libraries before parsing | Passed: Sharp 0.35.5, libheif 1.23.5, libvips 8.18.7 in Linux production image |
| Safe AVIF, HEIC and malformed-input behavior | Passed; HEIC metadata supported, unavailable HEVC rendering fails safely |
| Required scan success before native jobs and downloads | Passed: persisted proof matched to finalized key/provider, checked per claim/request |
| Upload replay cannot replace scanned/delivered content | Passed: server-only fresh snapshot, signed single/multipart replay and path-tampering tests |
| Atomic finalization and workspace isolation | Passed: real Postgres CAS, concurrent completion, abort/expiry rejection and rollback |
| Scanner outage/infection, missing/stale/legacy proof | Passed: processing and signing fail closed; recovery scans retained source |
| Runtime isolation | Passed: production-only graph, non-root/read-only, minimal environment and bounded resources |
| Repeatable CI evidence | Blocked on published head; fixture fixes pass locally and need successful remote CI |

No additional missing SEC-001 behavior was identified. Actual-length/bounded reads
and nested archive limits remain SEC-002's independent work. This review does not
claim that scanning alone eliminates archive exhaustion.

## Git Changes Reviewed

- In scope: native dependency/runtime gate, finalized uploads, scan proof persistence,
  processing/download gates, image/container/CI hardening and their tests/docs.
- Out of scope: pre-existing untracked `.dockerignore`, preserved and excluded.
- No unrelated service, historical audit or application database was modified.
- Earlier incomplete public commit `5053ee4` is not in current HEAD ancestry.
  Removal from existing caches/clones cannot be guaranteed.
- Local review fixes are limited to four code/test/script files plus review/status docs.

## Architecture and Code Quality

Existing Bun/Hono, strict TypeScript, Zod, injected repositories, Drizzle/Postgres
and provider-adapter layers are preserved. Finalized-key naming and scan decisions
are centralized; SQL remains in repositories. No new dependency or schema migration
was added during review. Test fakes mirror the new source/proof contract.

The fixture portability/readiness defects and redundant JSONB assertions were small
review fixes. Wider provider/SQL typing cleanup requires separate intent.

## Testing and Coverage

| Gate | Fresh result |
| --- | --- |
| Impacted tests first | 864 passed, 9 DB-dependent skips, 0 failed |
| Default full suite | 1592 passed, 19 skips, 0 failed |
| Final isolated full suite + coverage | 1609 passed, 0 failed, 4318 assertions, 94 files |
| Linux production build/gate | 179 passed, 0 failed, runtime and isolation assertions passed |
| Lint / typecheck / canonical schema mirror | Passed |

Overall isolated coverage: **96.47% functions / 98.57% lines**.

| Changed executable production file | Functions | Lines |
| --- | --- | --- |
| `uploads/complete.ts` | 100% | 92.55% |
| `uploads/create.ts` | 87.50% | 100% |
| `uploads/finalized-source.ts` | 100% | 100% |
| `processing/scan-gate.ts`, `processing/worker.ts`, `objects/download-url.ts` | 100% | 100% |
| `db/repositories/mappers.ts` | 100% | 100% |
| `db/repositories/object-and-session-repository.ts` | 97.56% | 100% |
| `db/repositories/variant-job-usage-repository.ts` | 100% | 100% |
| `providers/s3-adapter.ts` | 100% | 100% |
| `processors/native-image-runtime.ts` | 100% | 100% |
| `processors/sharp-image-processor.ts` | 88.89% | 94.55% |

Every changed executable production file exceeds the 80% function/line floor.
Type-only contracts are not executable. Existing integration test utility
`_helpers.ts` has 50% / 42.68% instrumented coverage; this PR only extends its fixture
name union, not its executable behavior. It is not a production coverage gap.
Bash gates are exercised directly rather than measured by Bun instrumentation.

Storage's developer guide and CI explicitly require the 80% floor; no local
ADR-001 file exists. The available Lumia ADR-001 was reviewed but applies to Lumia,
so its frontend tier targets were not substituted for storage's configured gate.
Tests cover permanent regressions; test-first authoring order cannot be proven
from the squashed commit history.

No remaining local test failures. The first isolated rerun failed during fixture
startup; final TCP readiness fixed that race and two subsequent runs passed.
Live hosted providers/scanner and LibreOffice sidecar were not provisioned here;
processor CI passed on the published head, with its documented LibreOffice skip.

## TypeScript Type-Check Review

- Formal command: `bun run typecheck` (`tsc --noEmit`), passed after fixes.
- Strict compiler settings unchanged; no new `any`, suppression or relaxed checking.
- Removed the new mapper assertion and existing redundant claim-payload assertion.
- Historical type debt remains in touched areas: provider `storageClass as never`
  at `s3-adapter.ts:209,242,466`, SDK signing/conditional-PUT assertions, and
  raw SQL/error casts in `variant-job-usage-repository.ts`.
- Those predate this story. Provider-neutral storage-class contracts and driver
  result/error narrowing deserve a focused follow-up; they were not expanded here.

## Security Review

Reviewed workspace ownership, internal actor/scope wiring, parameterized SQL,
client capability namespaces, DTO projection, generic gate errors, scanner failures,
provider error handling, source replay and container/build boundaries.

Sharp 0.35.5 exceeds the fixed thresholds for the audit's
[libheif advisory](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c)
and [libvips advisory](https://github.com/lovell/sharp/security/advisories/GHSA-f88m-g3jw-g9cj).
Loaded Linux libraries were verified, not inferred solely from the package pin.

No further introduced SEC-001 security blocker was identified. `bun audit` remains
nonzero: **18 existing development-tool advisories (13 high, 4 moderate, 1 low)**,
in ESLint-related brace-expansion/js-yaml and Drizzle-kit's esbuild; no Sharp match.
This does not establish an advisory-free image or close the broader audit.

Private buckets, provider copy semantics, scanner configuration and legacy URL
revocation/expiry remain rollout requirements. Privileged rewriting of finalized
objects/provider configuration is outside uploader replay protection.

## Database and Migration Review

No production schema change, migration, destructive SQL or backfill was introduced.
The existing key column and server-owned job JSONB hold the binding/proof.
Real isolated Postgres tests verify atomic finalization, workspace scope, rollback
and JSONB persistence. `bun run db:check` confirms the canonical infra mirror.

Only disposable fixture DBs were initialized and removed. No application/hosted
DB was written or reset. Rollback to older code would reopen these protections;
disable affected capabilities rather than treating a version revert as safe.
Production backup/restore evidence remains a separate release requirement.

## Documentation Review

Root AGENTS instructions followed; no service AGENTS file exists or was added.
Developer/API/runtime/deployment/readme/security docs describe the gates, legacy
recovery, provider copy capability, retention, test commands and rollback.
There is no changelog change required by the established workflow.

Updated current review, validation, status, PR handoff and FU-1 evidence to record
the failed published CI check and local corrections. Corrected upload-create
function coverage from 100% to the fresh 87.50% result. Existing historical
2026-09-30 artifact evidence is labeled separately. Design docs capture the
architecture decision; no unrelated ADR or historical audit rewrite was made.

## Commands Run

Commands ran in the storage repository unless an absolute path was specified.
Repeated read-only inspections are grouped; output was saved under
`/private/tmp/sec001-revalidation-*.log`.

- Git inventory: `git status`, `git status --short`, `git diff`,
  `git diff --staged`, `git log -3 --oneline`,
  `git log -5 --oneline --decorate --graph`, `git branch --show-current`,
  `git remote -v`: inspected; only original untracked file initially.
- Base verification: `git fetch origin develop`,
  `git rev-list --count origin/develop..HEAD`,
  `git merge-base origin/develop HEAD`: passed; one commit, base above.
- Branch inspection: `git diff --stat origin/develop...HEAD`,
  `git diff --name-only origin/develop...HEAD`, and scoped
  `git diff origin/develop...HEAD -- src`, config/docs/lockfile and tests:
  reviewed all 64 changed files.
- Local fixes: `git diff -- scripts/verify-immutable-source.sh src/infra/db/repositories/mappers.ts`:
  inspected, followed by complete final local diff.
- `git merge-base --is-ancestor 5053ee4e54429e75ea2e862f6547b79f80102a6c HEAD`:
  exit 1, expected; incomplete commit absent from ancestry.
- `gh pr view 32 --json url,state,baseRefName,headRefName,commits,statusCheckRollup`:
  initial restricted-network attempt failed; authorized network read succeeded.
- `gh run view 36753126160 --job 110016508311 --log-failed` and `--log`:
  returned empty output; raw API logs were used.
- `gh api repos/Xynes-Studio/xynes-storage-service/actions/jobs/110016508311`
  and `.../logs`: succeeded; fixture step exited 127 because `rg` was missing.
- `bun --version`: 1.3.4 on host.
- `bun test tests/actions/handlers/uploads tests/actions/handlers/processing tests/actions/handlers/objects tests/providers/s3-adapter.test.ts tests/infra/processors tests/integration/processors/sharp.integration.test.ts tests/integration/processors/image-upload-security.integration.test.ts`:
  864 pass / 9 skip / 0 fail.
- `bun run lint`: passed initially and after all TypeScript/test fixes.
- `bun run typecheck`: passed initially and after all TypeScript/test fixes.
- `bun run db:check`: passed.
- `bun test`: 1592 pass / 19 skip / 0 fail.
- `SEC001_MINIO_BINARY=/private/tmp/xyn-sec-001-fu-tools/minio bash scripts/verify-immutable-source.sh`:
  first failed on the temporary Postgres socket server; two corrected runs passed,
  including the final 1609-test full coverage run after code cleanup.
- `bash scripts/verify-release-image.sh local/xynes-storage:sec001-revalidation linux/amd64`:
  passed twice, including the final production code.
- `docker image inspect local/xynes-storage:sec001-revalidation --format '{{.Id}} {{.Architecture}} {{.Config.User}}'`:
  `sha256:2c68d8fc981b91f959ed707369ee00ccc875a7d398d487fb12f71bfbb9d8d090 amd64 bun`.
- `go version -m /private/tmp/xyn-sec-001-fu-tools/minio | awk ...`:
  exact module/version accepted; deliberately wrong version rejected.
- `bun audit`: exit 1, 18 existing development-tool advisories.
- `bash -n scripts/verify-immutable-source.sh scripts/verify-release-image.sh`,
  `git diff --check`, `git diff origin/develop...HEAD --check`: passed.
- Read-only `cat` / `sed` / `rg` / `nl` / `tail` inspections: attached request,
  root/service guide, package/TS config, original audit, available ADR-001,
  production handlers/runners/composition/provider/DB code, tests, Docker/Compose/CI,
  story/design/security/API/validation/review/handoff docs and gate logs.
  A few guessed ADR/source paths did not exist; actual paths were subsequently
  discovered and inspected. Markdown file links were checked after documentation edits.
- Official Sharp advisory pages were opened read-only to verify fixed-version ranges.

## Fixes Made During Re-validation

- `scripts/verify-immutable-source.sh`: replaced undeclared `rg` dependency with
  exact-field POSIX awk matching; added bounded final TCP readiness and TCP psql.
- `src/infra/db/repositories/mappers.ts`: removed unnecessary new JSONB cast.
- `src/infra/db/repositories/variant-job-usage-repository.ts`: removed existing
  unnecessary claim-payload cast and corrected its comment.
- `tests/actions/handlers/uploads/complete.test.ts`: corrected stale test comment.
- Review/status/evidence/handoff docs: updated verdict and fresh evidence.
- Final lint/typecheck, full isolated coverage and Linux build tests passed.
  No local commit, push, merge, PR creation, external message or deployment occurred.

## Suggested Commit Messages

- `fix: make immutable-source security gate portable and wait for final Postgres startup`
- `refactor: use inferred processing payload types`
- `docs: record SEC-001 revalidation and pending CI acceptance`

## Blocking Issues

1. **Published PR head still fails immutable-source-security.** The local script fix
   must be included in the PR, then the updated head must pass all checks.
   The failed check ran no immutable-source tests.
2. Local review fixes and corrected evidence are uncommitted/unpushed by instruction;
   the published PR therefore does not yet represent this validated local tree.

No additional SEC-001 implementation blocker was found.

## Recommended Follow-up Stories

- Existing SEC-002: actual-length enforcement, bounded reads and archive recursion/
  expansion/time limits; retain its existing owner and scope.
- Separate historical typing cleanup: narrow provider storage classes, SDK commands,
  conditional PUTs and SQL result/error boundaries without excluding supported providers.
- Existing dependency/supply-chain and broader release evidence stories:
  development-tool advisories, immutable base/provenance/image scans and backup/restore.

No new external tracker story was created.

## Final Notes

PR #32 already exists. Local implementation is validated, but its current published
head is **not ready for approval/merge** until the review fixes are published and CI
passes. Production rollout remains separately gated by target acceptance and legacy
capability handling. The pre-existing untracked `.dockerignore` remains untouched.
