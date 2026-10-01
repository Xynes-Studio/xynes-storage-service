# SEC-001-FU-1 implementation design

The user requires this follow-up in the combined SEC-001 PR before publication.
The earlier public branch has been deleted; replacement history will contain the
completed remediation only. No merge or deployment is authorized.

## Decision

Finalize staging uploads into fresh, server-controlled keys using same-bucket
`CopyObject`. Conditional browser PUT/multipart writes were rejected as a
provider-specific enforcement dependency. Provider versioning was rejected as a
new bucket requirement. A server snapshot needs neither feature and avoids an
additional full-file buffer during completion.

New upload URLs target `workspaces/<workspace>/uploads/v1/<object>/<filename>`.
Completion copies into `workspaces/<workspace>/finalized/v1/<object>/<random UUID>`.
Client single/multipart upload APIs refuse the finalized namespace. Copy failure
does not complete the session. Destinations are fresh for every attempt; a losing
completion cannot overwrite the winning source. The session/object transition
uses one Postgres transaction with a session lock and object compare-and-set.
The existing provider key column holds the finalized source; no migration is
needed. Required scan jobs persist the exact finalized key/provider in existing
server-owned job JSON when success is recorded. Public DTOs strip that evidence.

All processors and signed downloads require successful required scans whose
evidence matches the current finalized key/provider. Legacy keys and missing,
stale or inconsistent evidence fail closed. Retrying a scanner outage scans the
same source; part or single-URL replays address staging only. URL path tampering
must fail SigV4 verification. Subsequent provider configuration changes remain
privileged operations and require rollout review.

## Verification and lifecycle

Permanent harmless same-length replacement tests cover before processing, before
signing and after signing. Include competing completions, provider/DB failures,
multipart recovery/replay, legacy records, cross-workspace isolation and scanner
retry. Repeat regressions in the production Linux image and on isolated MinIO;
verify DB compare-and-set and proof persistence on isolated Postgres.

Successful completions delete staging best-effort; lost CAS candidates are
deleted best-effort. An uncertain DB commit must retain its candidate, since it
may be the accepted source. Operators expire upload staging only after the
maximum upload URL/session lifetime. Orphan finalized candidates must be compared
against DB references before deletion; never apply blanket finalized-prefix
expiry. Legacy issued GETs need explicit revocation or expiry before rollout
claims quarantine. Legacy objects require re-upload/finalization and a new scan;
old success must never be backfilled as bound proof.

Provider requirements: atomic independent same-bucket copies, private buckets and
SigV4 key binding. Unsupported/copy-failing providers fail closed at completion.
[AWS documents atomic copying up to 5 GB](https://docs.aws.amazon.com/AmazonS3/latest/userguide/copy-object.html);
[R2 lists CopyObject support](https://developers.cloudflare.com/r2/api/s3/api/);
[B2 lists Copy Object](https://www.backblaze.com/docs/cloud-storage-call-the-s3-compatible-api).
Isolated MinIO evidence establishes the representative provider flow, not live
credential validation of every configured workspace provider.
