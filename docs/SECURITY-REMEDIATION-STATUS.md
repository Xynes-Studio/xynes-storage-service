# Storage security remediation status — updated 2026-10-05

| Work                                                                   | Status                                             | Evidence                                                                                                                    |
| ---------------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| SEC-001 patched decoders, bound scan quarantine and container controls | **Merged — storage PR #32 on 2026-10-01** | [Validation](XYN-SEC-001-validation.md), [review](XYN-SEC-001-pre-pr-review.md)                                             |
| SEC-001-FU-1 immutable scan/content binding                            | **CLOSED — implemented and validated in SEC-001**  | [Story](plans/2026-09-30-XYN-SEC-001-FU-1-immutable-scan-content.md), [design](plans/2026-09-30-XYN-SEC-001-FU-1-design.md) |
| Production deployment / broader audit release                          | **Not authorized or performed**                    | [Rollout requirements](native-image-security.md#legacy-rollout-and-retention) and other audit findings remain applicable    |
| SEC-002 actual-length/archive limits | **Merged — storage #33 / infra #121 on 2026-10-01; target rollout pending** | [Review](XYN-SEC-002-pre-pr-review.md) |
| SEC-005 release image hardening | **[PR #34 open](https://github.com/Xynes-Studio/xynes-storage-service/pull/34); validated 2026-10-02; merge pending** | [Verification](XYN-SEC-005-verification.md), [review](XYN-SEC-005-pre-pr-review.md) |

This supersedes the earlier scope split: the user required FU-1 to be completed
before the combined PR. Upload completion finalizes server-only content, and scan
proof is checked against that key/provider on both processing and signed delivery.
The original audit findings remain historical; its October 5 progress register
records current merged and pending work. No external
tracker or production state is changed by this record.

SEC-001 (including FU-1) and SEC-002 are merged implementation work. SEC-005
passed local host/development/release-artifact checks on amd64 and arm64; its
changes await review/merge. Production rollout still requires legacy capability
revocation/expiry, target-provider acceptance and the other audit release evidence.

Do not claim all audit findings are closed or production is approved.

## Workflow references

- [Parent design](plans/2026-09-30-XYN-SEC-001-design.md) and [FU-1 design](plans/2026-09-30-XYN-SEC-001-FU-1-design.md).
- [Implementation/validation](XYN-SEC-001-validation.md), [pre-PR review](XYN-SEC-001-pre-pr-review.md), [PR handoff](XYN-SEC-001-pr-handoff.md).
- [API](api-contract.md), [native/runtime operation](native-image-security.md), [deployment posture](deployment-posture.md).
