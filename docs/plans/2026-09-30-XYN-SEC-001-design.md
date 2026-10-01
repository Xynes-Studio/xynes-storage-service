# XYN-SEC-001 — patched native image processing

SEC-001 includes the completed [SEC-001-FU-1 content-binding design](2026-09-30-XYN-SEC-001-FU-1-design.md):
server-only finalized sources and persisted scan proof matched on both processing
and signed delivery. [Current status](../SECURITY-REMEDIATION-STATUS.md) and
[pre-PR review](../XYN-SEC-001-pre-pr-review.md) record final validation. SEC-002
retains independent size/archive scope. Merge and deployment remain separate.

The approved approach upgrades Sharp to the current patched stable release while
preserving image-format support. The storage service remains Bun/Hono/TypeScript,
with Drizzle repositories and injected provider, scanner and worker ports.

Pin Sharp 0.35.5 and its Bun lockfile, including the bundled libheif 1.23.5 and
libvips 8.18.7. Reject older, missing or unverifiable native versions before
decoding. Keep the existing lazy-load safe-fail behavior: an unsafe native
runtime cannot decode and image jobs fail through the production stub. Stub
mode remains independent of native libraries. Response shapes, database schema,
authentication and authorization remain unchanged. Download availability is
tightened by the scan gate approved by the user for closure in this ticket.

Persist successful required scan validation before any non-scan runner starts
or any signed download is minted. Check the workspace-scoped queue on each
attempt, including across workers. Pending scans defer processing without
consuming retries; missing, failed, cancelled or inconsistent evidence blocks
processing and delivery. Scanner outages fail closed. Existing retry processing
rescans after an operator resolves the failure; legacy keys/unbound proof remain unavailable until re-uploaded through finalization
and legitimately scanned.

Build production dependencies inside Linux, copy only runtime files, and run
as Bun's non-root user. Provide a Compose security overlay and an executable
release-image check with a read-only filesystem, no capabilities, bounded
memory/CPU/PIDs, and a bounded temporary filesystem for the video processor.
The existing untracked .dockerignore is preserved; a Dockerfile-specific
allowlist controls the build context independently.

Tests cover the native version gate, safe AVIF input/output, malformed HEIF
input, upload completion through the queue and real Sharp with a fixture
provider, workspace denial, scanner failure preventing decoding and delivery,
cross-worker deferral and recovery through the existing retry action.
The Linux check runs against the production artifact without external network
or credentials. CI must execute the same artifact check. The storage service's
configured coverage gate remains at least 80% for functions and lines.

Sharp still shares the service process and its required DB/internal/provider
credentials. Non-root/read-only limits reduce host/container authority but do
not isolate those credentials from native code. A separate worker identity is
architectural follow-up; XYN-SEC-002/003 remain independent findings. This work
does not change the original audit's production release decision or deploy.
