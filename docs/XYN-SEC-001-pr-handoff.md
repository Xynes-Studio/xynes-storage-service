# SEC-001 + FU-1 PR and release handoff

Title: **fix: patch native image runtime and bind scan proof to finalized content**
Base: `develop`. The user authorized the combined PR after completing FU-1 and
requires replacement history excluding the earlier incomplete commit. The earlier
public branch is deleted. Verify the required Git identity/access before publishing;
preserve the pre-existing untracked `.dockerignore`. Merge/deployment need separate authorization.

## Reviewer summary

Pin and assert patched Sharp/libheif/libvips in the Linux production runtime.
Finalize uploads into fresh server-only keys with an atomic session/object
transition. Persist scan source/provider proof and match it before processing
or signed delivery. Legacy/unbound proof fails closed. Client upload/part replay
cannot change accepted sources, including behind already-issued signed GETs.
SEC-001-FU-1 is implemented and validated in this PR; SEC-002 keeps its own scope.

Validation: **1609 isolated provider/DB tests passed**, **96.47% functions / 98.57%
lines**, lint/typecheck passed; Linux build and **179 artifact tests** plus isolation
assertions passed. [Evidence](XYN-SEC-001-validation.md), [review](XYN-SEC-001-pre-pr-review.md),
[FU-1 story](plans/2026-09-30-XYN-SEC-001-FU-1-immutable-scan-content.md),
[current status](SECURITY-REMEDIATION-STATUS.md). CI must pass for the PR head.

## Rollout

No schema migration or response-shape change. Provider credentials need atomic
same-bucket CopyObject capability and private buckets. Apply storage-only runtime
env and the production security overlay last (Compose >=2.24.4). Stop old instances;
revoke/remove or expire existing legacy URLs before claiming quarantine. Legacy
objects need finalized re-upload and a new scan. Never backfill success or enable
legacy fallback. Configure staging expiry beyond the maximum upload lifetime and
reconcile unreferenced snapshot candidates safely. Verify the actual release
artifact/scanner/providers/DB. See [rollout policy](native-image-security.md#legacy-rollout-and-retention).

## Rollback

Reverting native versions reopens SEC-001: keep live native processing disabled
if rollback is necessary. Reverting finalization/proof gates reopens content
identity protection and can misread existing finalized objects; disable new
upload/processing/download capabilities until an approved recovery is available.
No DB schema rollback is needed. Preserve accepted snapshots and references.

## Closure checklist

- [x] SEC-001-FU-1 source binding and permanent regressions complete.
- [x] Isolated provider/Postgres, quality and Linux artifact gates pass locally.
- [x] API, design, developer, deployment, review/status and retention docs updated.
- [ ] CI passes on the final combined PR head.
- [ ] Operator performs separately authorized target rollout and legacy capability handling.
