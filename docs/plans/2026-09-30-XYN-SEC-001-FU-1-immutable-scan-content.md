# XYN-SEC-001-FU-1 — Bind scan success to immutable content

- Status: **CLOSED — implementation and pre-PR validation complete**.
- Priority: High / P1. Included in the combined SEC-001 PR against `develop`.
- Owner: storage/backend. SEC-002 remains independent; no archive scope added.
- No external tracker issue, merge or production deployment is included.

## Outcome

Upload completion snapshots staging into a fresh server-only key. A single
Postgres transaction locks the session, checks workspace/object/staging identity
and expiry, binds the accepted key and completes both rows. Concurrent losers
cannot change the accepted source. Required scan success persists its exact
source key/provider in existing server-owned JSONB. Workers and downloads require
that proof to match a finalized source. Client upload APIs refuse finalized keys.

Replaying staging upload capabilities cannot change processed/downloaded bytes,
including after a GET URL is issued. Legacy/unbound proof fails closed. The caller
checksum remains dedup metadata, not security evidence. No schema migration,
versioned bucket, new conditional browser header or public response change is
required. See [the design](2026-09-30-XYN-SEC-001-FU-1-design.md).

## Verified acceptance

- [x] Scan proof identifies the finalized source key and provider used by processing and delivery.
- [x] Single PUT replay affects staging only; path tampering fails SigV4 verification.
- [x] Same-length/same-header replacement before native processing cannot replace the accepted source.
- [x] Replacement before and after signing cannot change bytes behind the issued GET.
- [x] Multipart/part replay cannot mutate the snapshot; completion stays idempotent.
- [x] Competing completions commit exactly one source; abort, expiry and DB failure cannot publish partial state.
- [x] Missing/stale/inconsistent proof denies native processing and signing; retries scan the retained source.
- [x] Workspace isolation and redacted public envelopes are preserved; internal proof does not leak into DTOs.
- [x] Infected/unknown scanner outcomes still prevent processing/delivery; recovery requires a clean scan.
- [x] Legacy object/scan recovery and outstanding URL revocation/expiry policy is documented.
- [x] Atomic same-bucket copy/private bucket capabilities are documented; unsupported/copy failures fail closed.
- [x] Isolated official-source MinIO verifies signed single/multipart, tampering and after-signing behavior.
- [x] Permanent harmless replacement regressions and the Linux production-image gate pass.
- [x] Full isolated Postgres/provider tests, lint, typecheck, release build and changed-file coverage >=80% pass.

## Evidence

2026-10-01: local full isolated coverage and production-image gates pass again.
Published PR #32 still needs local fixture portability/readiness corrections and
successful CI before approval; implementation closure does not waive that gate.
See the [current review](../XYN-SEC-001-pre-pr-review.md).

`bash scripts/verify-immutable-source.sh`: **1609 passed, 0 failed**, with disposable
loopback MinIO/Postgres and no hosted credentials. Coverage **96.47% functions /
98.57% lines**. The script cleans its own fixtures and runs independently in CI.
Linux production image: **179 passed, 0 failed**, patched runtime and isolation
checks passed. [Validation](../XYN-SEC-001-validation.md) records artifact identity
and per-file coverage. [Review](../XYN-SEC-001-pre-pr-review.md) revalidates closure.

## Rollout and retention

Implementation closure does not mean production deployment. Follow
[legacy rollout/retention](../native-image-security.md#legacy-rollout-and-retention):
stop old writers/signers; revoke/remove legacy keys or wait for all legacy signed
capabilities to expire; re-upload/finalize and scan legacy objects; verify each
configured provider/scanner; retain referenced finalized originals. Never backfill
old success, allow legacy fallback or expire all finalized keys. Uncertain DB
commit candidates require reference reconciliation before deletion.

The earlier public branch was deleted at the user's request. The replacement PR
history must contain the complete fix without the earlier incomplete commit.
Deleting branch history cannot guarantee removal from caches or existing clones.
