# XYN-SEC-005 — reproducible, restricted storage image

The September 30 audit demonstrated root execution and broad context copying.
Merged SEC-001 already supplies a production dependency stage, explicit runtime
copies, non-root `bun`, Dockerfile-specific context filtering and a last-applied
read-only/resource/capability Compose overlay. Preserve those controls and the
live native processors while completing the remaining artifact requirements.

## Approach

Extend the existing multi-stage image: pin its currently resolved Bun version
and multi-platform digest, narrow runtime source/scripts to TypeScript, exclude
private material even inside admitted directories, and exercise the actual
Docker build context plus final image. This is the smallest compatible change.
A replacement minimal/distroless base would require new native-library and shell
compatibility work. Separating the worker into a new container/identity changes
architecture and belongs to a separate story.

## Build and runtime contracts

The base becomes `oven/bun:1.4.2` at the verified OCI index digest, supporting
Linux amd64 and arm64. Dependencies remain installed from committed `bun.lock`
inside Linux. Only manifests, production dependencies, runtime TypeScript and
the native assertion script reach the final image. The existing development
stage retains full dependencies, tests, TypeScript config and formatting/lint
config; source/script runtime inputs are TypeScript. The tracked
`Dockerfile.dockerignore` takes precedence for this Dockerfile, preserving the
user's pre-existing untracked `.dockerignore`.

Deny local Git/dependencies/env/log/coverage material plus AWS/SSH directories,
registry/netrc credentials and PEM/key/PKCS12 files at any admitted depth.
A temporary test stage copies a synthetic context to inspect Docker's actual
filtering: required runtime files survive and private/unlisted canaries do not.
Never put real credentials into that fixture. The temporary image is removed.

## Verification and operation

Add test-first base pinning and Linux-only artifact tests. Check the exact final
`/app` manifest, missing dev-only packages, source types, dedicated UID/GID 1000,
zero capability sets, no-new-privileges, read-only rootfs and bounded `noexec`
`nosuid` scratch. Run actual Sharp/ffmpeg fixtures with dependencies from the
release image and hard-fail if the ffmpeg binary is absent. Existing upload,
scan-quarantine, immutable-source and provider regressions remain in the harness.
The existing CI release-image job invokes the enhanced harness.

No API/authentication logic, schema, data, new dependency, lockfile or environment
contract changes. No database backup/migration is required because no database
is touched. Production deployment remains a separate operation: apply the
existing security overlay last and supply a storage-only ignored env file.
An image by itself cannot enforce capability/rootfs settings. Digest updates
require repeating this verification; do not silently resume a mutable base.
