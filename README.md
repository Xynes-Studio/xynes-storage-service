# Xynes Storage Service

Platform-level workspace object storage and file upload service for the Xynes ERP.

> **Status:** STORAGE-1 — Architecture & docs phase. **No runtime code yet.**
> The runnable Bun/Hono service skeleton, provider adapters, and tests land in
> STORAGE-4. Until then, this repo holds only the architecture contract,
> developer guide, and API contract that downstream stories will build against.

## Scope

`xynes-storage-service` owns:

- Upload session lifecycle (`POST /storage/uploads` create / complete / abort).
- Storage object metadata (list, read, signed read URL, soft-delete).
- Workspace storage provider configuration metadata (credential references only — never raw credentials).
- Async processing job state (validation/scan/compression/preview/transcode).
- Storage object variants (thumbnails, responsive images, video posters, etc.).
- Daily usage aggregates.

This service is **platform-level**, not CMS-specific. CMS authoring is the
first consumer, but the contract is universal — any Xynes app may use it.

## Non-goals

- No CMS-specific concepts inside this service.
- No in-app provider configuration UI.
- No synchronous large-file streaming through the gateway.
- No customer-owned bucket onboarding in MVP.
- No advanced DAM features (folders, focal-point editing, moderation queues) in v1.

## Documentation

- [`DEVELOPER.md`](./DEVELOPER.md) — developer contract, planned action keys, actor surface, folder layout.
- [`docs/architecture.md`](./docs/architecture.md) — local mirror of the high-level architecture.
- [`docs/api-contract.md`](./docs/api-contract.md) — planned route table, request/response shapes.
- Cross-repo epic (source of truth):
  [`xynes-infra/infra/architecture/epics/universal-object-storage.md`](https://github.com/Xynes-Studio/xynes-infra/blob/main/infra/architecture/epics/universal-object-storage.md)
- Source plan with full story breakdown:
  [`xynes-infra/docs/plans/2026-05-10-universal-object-storage-file-upload-api.md`](https://github.com/Xynes-Studio/xynes-infra/blob/main/docs/plans/2026-05-10-universal-object-storage-file-upload-api.md)

## Branch model

- `main` — release branch. Protected. Status checks and admin enforcement
  enabled in STORAGE-4.
- `develop` — long-lived working branch. All `feature/*` branches diverge from
  `develop` and merge back via PR. Releases promote `develop → main`.

Open PRs against `develop` unless landing a release-time fix. See
[`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Local development

Local development tooling lands in **STORAGE-4** (Bun runtime, Hono app
scaffold, internal route, tests, Dockerfile). Until that story lands there is
no `bun install` step and no service to run locally.

## License

MIT — see [`LICENSE`](./LICENSE).

Copyright © 2025 Xynes Studio.
