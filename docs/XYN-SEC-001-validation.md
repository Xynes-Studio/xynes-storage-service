# XYN-SEC-001 and FU-1 implementation/validation — 2026-09-30

**READY FOR PR against `develop`: SEC-001-FU-1 is implemented and locally closed.**
The user requires a combined fix and replacement history without the earlier
incomplete commit. The earlier public branch was deleted. No merge/deployment
is authorized. The original audit remains unchanged.

## Implementation

- Exact Sharp **0.35.5** / libheif **1.23.5** / libvips **8.18.7**; loaded-version gate before native parsing and existing non-decoding fallback.
- Linux frozen production install, runtime-only image, non-root user and storage-only Compose overlay with read-only filesystem and resource controls.
- New uploads address staging. `CopyObject` snapshots into fresh server-only keys; finalized-key client upload signing is refused.
- `finalizeIfPending` locks the session and atomically binds its pending object/key and completed state. Losing or failed transactions do not replace accepted content.
- Scan success persists its finalized key/provider in existing job JSONB. Worker and download gates require matching proof; legacy, missing, failed, pending or stale proof fails closed.
- Public DTOs, action keys and schema remain unchanged. Caller hashes remain metadata, not scan proof. No new runtime dependency beyond Sharp/native update.
- Retry, multipart/part replay, concurrent completion and signed-GET regressions use harmless fixture content. Actual signed provider flows run on isolated MinIO; transaction/proof tests run on isolated Postgres.
- CI runs quality gates, Linux release-image security and isolated immutable-source/provider/DB coverage.

## Final checks

| Check                                                                                    | Result                                                                                          |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `bash scripts/verify-immutable-source.sh`                                                | **1609 passed, 0 failed**, all DB/provider fixtures active; **96.47% functions / 98.57% lines** |
| `bun run lint`                                                                           | Passed                                                                                          |
| `bun run typecheck`                                                                      | Passed                                                                                          |
| `bash scripts/verify-release-image.sh local/xynes-storage:xyn-sec-001-final linux/amd64` | Production build, **179 artifact tests**, native/runtime and Compose/container isolation passed |
| Bash syntax and `git diff --check`                                                       | Passed                                                                                          |
| Dependency audit from SEC-001 review                                                     | 18 existing development-tool advisories; no Sharp/native match; not remediated by this ticket   |

Changed production coverage from the isolated full gate:

| File                                                                         | Functions | Lines  |
| ---------------------------------------------------------------------------- | --------- | ------ |
| `uploads/complete.ts`                                                        | 100%      | 92.55% |
| `uploads/create.ts`                                                          | 100%      | 100%   |
| `uploads/finalized-source.ts`                                                | 100%      | 100%   |
| `processing/scan-gate.ts`, `processing/worker.ts`, `objects/download-url.ts` | 100%      | 100%   |
| DB `mappers.ts`                                                              | 100%      | 100%   |
| DB `object-and-session-repository.ts`                                        | 97.56%    | 100%   |
| DB `variant-job-usage-repository.ts`                                         | 100%      | 100%   |
| `s3-adapter.ts`                                                              | 100%      | 100%   |
| `native-image-runtime.ts`                                                    | 100%      | 100%   |
| `sharp-image-processor.ts`                                                   | 88.89%    | 94.55% |

Every changed production file meets the configured 80% function/line floor.
The existing type-only contracts have no executable coverage obligation.

## Artifact/provenance

Final production image: `sha256:eacb43b7c2a7c121fd377b8b626c8e47fbb7bc888a284731987acb43eac56cf2`.
Linux amd64, Bun 1.4.2, default user `bun`/UID1000. Native assertions loaded
Sharp 0.35.5, libheif 1.23.5 and libvips 8.18.7. The verifier ran networkless,
read-only, non-root, capability-free with no privilege escalation and bounded
CPU/memory/PIDs/tmpfs. Safe AVIF decode/render and HEIC metadata are covered;
bundled HEVC pixel rendering remains unsupported, as before.

Isolated provider: official MinIO release `RELEASE.2025-10-15T17-29-55Z`, Go module
`v0.0.0-20251015172955-9e49d5e7a648`, built from source with Go 1.25.6. No third-party
MinIO image is used. Isolated Postgres image:
`postgres@sha256:f1c3376c26f2609ab9f29f71f824103fe2fcd8ee0346485cb6122a4f93df6f94`.
Fixture schema copies canonical storage DDL/indexes; simplified workspace/user
anchors support synthetic FK fixtures only. Never apply it to an app database.

## Scope and operational limits

The proof is a fresh service-controlled object key and provider identity, not
bucket Object Lock or protection against privileged credential/configuration
compromise. Finalized keys must never be rewritten. The private bucket and atomic
independent-copy contract must be verified for configured providers. Copy failures
remain pending; scanner failures block processing/signing. Hosted credentials,
production data, target scanner provisioning, backup/restore and whole-image CVE
scanning were not exercised. Other audit findings remain independent.

Legacy keys/unbound scan rows remain unavailable. Already-issued legacy provider
URLs require revocation/removal or expiry before rollout claims quarantine.
Legacy recovery requires finalized re-upload plus a new scan; no success backfill
or fallback is provided. See [rollout/retention](native-image-security.md#legacy-rollout-and-retention).
No application schema/data was changed; only disposable fixture databases were
initialized/tested. The pre-existing `.dockerignore` is preserved and excluded.

[Current status](SECURITY-REMEDIATION-STATUS.md), [FU-1 story](plans/2026-09-30-XYN-SEC-001-FU-1-immutable-scan-content.md),
[design](plans/2026-09-30-XYN-SEC-001-FU-1-design.md), [review](XYN-SEC-001-pre-pr-review.md)
and [handoff](XYN-SEC-001-pr-handoff.md) carry the combined closure state.
