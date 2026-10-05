# XYN-SEC-005 — storage release image hardening

Date: 2026-10-02. Branch: `feature/XYN-SEC-005-storage-image-hardening`.
Pulled `origin/develop` before storage edits: `e9e00df`. Infra documentation was
updated first, then pulled current `origin/develop`: `94bd932`.

## Result

SEC-001 already removed broad final-stage copying/root execution. This change
finishes the base pin, tightens context filtering and adds direct artifact proof:

- `Dockerfile` pins Bun **1.4.2** to OCI index
  `sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895`.
  The official registry returned the same digest for `:1` and `:1.4.2` on October 2.
- Tracked `Dockerfile.dockerignore` is deny-by-default and excludes private files
  even inside source/tests/scripts; source and scripts admit TypeScript only.
  Docker uses this policy in preference to the preserved local `.dockerignore`.
- `scripts/verify-release-image.sh` tests synthetic context admission/exclusion
  with actual Docker, then checks the final artifact and runs real Sharp/ffmpeg
  under UID/GID 1000, read-only/no-new-privileges and zero capabilities.
- `tests/security/release-image.test.ts` checks the base pin on the host; its
  artifact checks require `STORAGE_RELEASE_IMAGE_TEST=1` inside the verifier.
  They intentionally skip on a host. The image run requires all four to pass.

Production dependencies/source stay built inside Linux. Tests are mounted
read-only solely for verification and are absent from the baked runtime. Existing
`compose.security.yml` controls remain required; an ordinary `docker run` does
not automatically drop capabilities or make the rootfs read-only.

## Test-first and validation evidence

Baseline fixture-only suite: **1,719 passed, 18 skipped, zero failed**. Initial
sandbox-only execution could not bind loopback port 0; the permitted baseline
passed without code changes. Baseline TypeScript check also passed.
The new immutable-base test failed against the original mutable `oven/bun:1`
reference and passed after pinning. Actual Docker canaries caught directory
negation inheritance admitting non-TypeScript files; explicit child exclusions
corrected that issue before final artifact acceptance.

[Pre-PR re-validation](XYN-SEC-005-pre-pr-review.md) repeats all gates after
small verifier fixes: unique temporary tags, broader private-file canaries,
bounded health fetch and stronger base-stage assertions. It also records eight
negative probes proving the checks reject unsafe images/configurations.

| Command / check | Result |
| --- | --- |
| Fixture-only `bun run test` (host Bun 1.3.4) | **1,720 passed, 22 skipped, zero failed**, 99 files |
| Configured `bun run test:coverage` (host) | **96.25% functions / 98.45% lines**, 80% gate passed |
| `bun run lint`, `bun run typecheck` (host) | Passed |
| Pinned Linux arm64 development image build | Passed; native binary assertions passed |
| Development-image `bun run typecheck`, `bun run lint`, `bun run test:coverage` (Bun 1.4.2) | Passed; **1,578 passed, 47 skipped, zero failed**, **92.72% functions / 94.30% lines** |
| `verify-release-image.sh ... linux/amd64` | Passed context/private-file canaries, Compose isolation, bare image manifest, four artifact tests, **212** processor/scan/provider regressions and default-entrypoint `/health` |
| `verify-release-image.sh ... linux/arm64` | Same checks passed, including real native ARM binaries |
| Infra `bash scripts/test/run.sh` | All script suites passed |
| Infra `bash scripts/lint.sh` | Passed documented `bash -n` fallback; shellcheck is unavailable |
| Storage `bash -n scripts/verify-release-image.sh`; both repositories `git diff --check`; follow-up JSON parse | Passed |

Image test runs intentionally skip the one host-only Dockerfile pin test, which
passes in host and development suites. The host's four artifact tests skip
because they require a Linux release container; all four pass on both image
architectures. Other full-suite skips are existing opt-in DB/sidecar/provider or
binary gates. Host and bare development-image counts differ with optional
processor availability; the release harness explicitly places its bundled
ffmpeg on PATH and requires those processor tests. No skipped provider/sidecar
integration is claimed as target deployment evidence.

No production TypeScript module changed; changed executable work is the build
configuration and Bash verifier. Its context allow/deny paths, cleanup, Compose
isolation, rootfs/capability checks, native regressions and default entrypoint
were exercised on both Linux architectures. Package coverage meets the 80%
function/line floor on both host and pinned runtime. TypeScript additions are
strongly typed tests; no `any`, suppression or new compiler bypass. Existing
`skipLibCheck` and unrelated optional-fixture coverage remain unchanged.

Verified local image configuration IDs (both `user=bun`):

- amd64: `sha256:fb5d3c7dc899edb43c44da2b5538e2d723a58e777152c06757d835766d270623`
- arm64: `sha256:49e8a6de91e9285c6a6a10bd0d062955a8dad82080f24d8d546fccc3089553a0`

These identify the locally tested images, not published registry artifacts.
Base/lock pinning stabilizes build inputs; no claim of bit-identical provenance
attestations or an approved image-CVE scan is made.

Local logs are retained under `/private/tmp/xyn-sec-005/` (`final-tests.log`,
`coverage.log`, `typecheck.log`, `lint.log`, `release-amd64.log`,
`release-arm64.log`, `dev-build.log`, `dev-quality.log`, `infra-tests.log`,
`infra-lint.log`). These are local verification artifacts, not committed secrets.
The production image alone contains no tests or development source mounts.
The final entrypoint smoke is loopback liveness with an unreachable fixture DB;
it does not certify `/ready`, provider access or a deployed application.
Temporary context-check images and health containers are removed by the harness.

Implementation/local artifact acceptance is complete. Changes remain local and
uncommitted pending review/merge; no push, PR, production deployment or release
approval was performed.

## Use and rollback

```bash
XYNES_ENV_FILE=/path/to/fixture-only.env bun run test
XYNES_ENV_FILE=/path/to/fixture-only.env bun run test:coverage
bun run lint
bun run typecheck
bash scripts/verify-release-image.sh local/xynes-storage:sec005 linux/amd64
# Repeat for the other deployment architecture when applicable:
bash scripts/verify-release-image.sh local/xynes-storage:sec005-arm64 linux/arm64
```

The production Docker build is this repository's release build; no package
`build` script exists. The existing CI `release-image-security` job runs this
same harness. Apply `compose.security.yml` last, using the existing
`STORAGE_RUNTIME_ENV_FILE` contract described in
[native image security](native-image-security.md#production-compose-and-least-privilege).
Runtime has no new environment variables; the new test flag belongs only to the
verification container. Update the pinned digest through a reviewed, revalidated
change. Roll back to a previously validated digest/image while retaining the
security overlay; do not remove isolation or restore broad runtime copying.

No API response, auth policy, database schema/migration or production-data change.
No new dependency, package-manager update or TypeScript bypass was introduced.
Existing `skipLibCheck` remains unchanged. No real provider, mail, hosted endpoint
or application database is used. The user's untracked `.dockerignore` and infra
`supabase/config.toml` are preserved. Final deployment acceptance, image CVE scan,
backup/restore evidence and other open audit tickets still need their own work.


## Publication preparation — 2026-10-05

Separate PR publication against `develop` is user-authorized. Latest pulls have
no incoming code changes from the validated baseline. See the
[review publication addendum](XYN-SEC-005-pre-pr-review.md#publication-preparation--2026-10-05)
for identity, scope and preservation checks. Validation dates above remain
October 2; publication does not authorize merge or deployment.

Published PRs against `develop`: [storage #34](https://github.com/Xynes-Studio/xynes-storage-service/pull/34) and
[infra #125](https://github.com/Xynes-Studio/xynes-infra/pull/125).
Both remain open for review and merge.
