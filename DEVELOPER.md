# Xynes Storage Service — Developer Guide

> **Status: STORAGE-1 (architecture & docs only).**
> This document is **forward-looking**. The runtime, route handlers, tests,
> Docker image, and CI workflows land in **STORAGE-4**. Until then, this
> repository holds only the contract documentation that downstream stories
> build against.
>
> When a section is marked `[planned — STORAGE-N]`, the contract is fixed but
> the implementation lives in story STORAGE-N.

## TL;DR

`xynes-storage-service` is the platform-level workspace object storage and
file upload service for the Xynes ERP. It owns upload session lifecycle,
storage object metadata, provider adapters, signed URLs, processing job
state, variants, and usage aggregates. CMS authoring is the first consumer,
but the contract is **universal** — any Xynes app may use it.

The service follows the standard Xynes backend pattern: a Bun/Hono Postgres
service that exposes a single `POST /internal/storage-actions` internal route called
by `xynes-gateway`. All requests are workspace-scoped. Every action requires
either a user JWT or a workspace API key — **there are no anonymous public
actions in the MVP.**

## Contract

### Health & Readiness (public, no auth) — `[planned — STORAGE-4]`

| Method | Path     | Returns                                                  |
| ------ | -------- | -------------------------------------------------------- |
| `GET`  | `/health` | `200 { ok: true, service: "storage-service" }`           |
| `GET`  | `/ready`  | `200 { ok: true, deps: { db: "ok" } }` when ready        |

### Internal Actions (requires gateway-forwarded actor) — `[planned — STORAGE-5+]`

- Route: `POST /internal/storage-actions`
- Auth: gateway forwards `X-Internal-Service-Token`, the actor surface
  (`X-XS-Actor-Type` + actor identity headers), and `X-Workspace-Id`.
- Envelope: `{ actionKey: string, payload: unknown }` validated via Zod strict
  parse. Same canonical envelope as `xynes-accounts-service` and
  `xynes-cms-core`.
- Response: `{ ok: true, data, meta: { requestId } }` on success;
  `{ ok: false, error: { code, message, details? }, meta: { requestId } }`
  on failure.

**No public/anonymous actions in MVP.** Every storage action requires
`X-Workspace-Id` plus an actor. If a future use case requires anonymous
storage reads (e.g., public CDN delivery), it must be approved by an ADR
before being added.

## Global Standards

- Runtime: **Bun** (matches the rest of the backend service tier).
- Language: **TypeScript** with strict mode.
- Web framework: **Hono**.
- Validation: **Zod** strict schemas. Payloads parsed via `z.strict()` to
  reject unknown fields.
- DB: **Drizzle ORM** + `postgres` (introduced in STORAGE-4 once
  `platform.storage_*` tables exist).
- Lint: **ESLint** (matches `xynes-accounts-service`). Not Biome.
- Tests: Bun test runner; coverage gate **≥80%** per ADR-001.
- Dependency injection for repositories (matches PFU-1 / CMS-API-KEY-ACTOR-1
  patterns).

## Folder Structure `[planned — STORAGE-4]`

Mirrors `xynes-accounts-service` exactly so a future contributor needs zero
context switch.

| Path                              | Purpose                                                              |
| --------------------------------- | -------------------------------------------------------------------- |
| `src/index.ts`                    | Bootstrap. Reads `PORT`, starts the Hono app from `src/app.ts`.      |
| `src/app.ts`                      | Hono app wiring (middleware order, route mounting).                  |
| `src/controllers/health.ts`       | `GET /health`.                                                       |
| `src/controllers/ready.ts`        | `GET /ready` (probes DB once STORAGE-4 wires it).                    |
| `src/middleware/requestId.ts`     | Per-request `X-Request-Id` propagation.                              |
| `src/middleware/errorHandler.ts`  | Maps action errors → canonical error envelope.                       |
| `src/middleware/internalServiceAuth.ts` | Verifies `X-Internal-Service-Token` from the gateway.          |
| `src/routes/internal.route.ts`    | `POST /internal/storage-actions` envelope + actor parsing + dispatcher.       |
| `src/actions/types.ts`            | `UserActor`, `ApiKeyActor`, `ActionActor`, `ActionContext`.          |
| `src/actions/errors.ts`           | `UnknownActionError`, `ValidationError`, `UnauthorizedError`, `ForbiddenError`, `ForbiddenActorKindError`. |
| `src/actions/guards.ts`           | `requireUserId`, `requireWorkspaceId`, `requireUserActor`, `getOptionalUserId`, `isApiKeyActor`. Reused PFU-1 surface. |
| `src/actions/schemas.ts`          | Zod payload schemas keyed by action key.                             |
| `src/actions/registry.ts`         | `ACTION_HANDLERS` map from action key → handler fn.                  |
| `src/actions/execute.ts`          | `executeStorageAction(key, payload, ctx)` dispatcher.                |
| `src/actions/handlers/uploads/`   | Upload session create/complete/abort handlers — `[STORAGE-5]`.       |
| `src/actions/handlers/objects/`   | Object list/get/download-url/delete handlers — `[STORAGE-6]`.        |
| `src/actions/handlers/processing/`| Process retry handler — `[STORAGE-7]`.                               |
| `src/actions/handlers/providers/` | Provider adapter wiring — `[STORAGE-4]`.                             |
| `src/actions/handlers/usage/`     | Usage read handler — `[STORAGE-6]`.                                  |
| `src/infra/db/`                   | Drizzle client, repositories — `[STORAGE-4]`.                        |
| `src/infra/providers/`            | Provider adapter implementations (R2 + local) — `[STORAGE-4]`.       |
| `src/workers/`                    | Async processing workers — `[STORAGE-7/8]`.                          |
| `tests/`                          | Unit + integration tests.                                            |
| `scripts/`                        | `run-with-env.ts`, smoke harnesses.                                  |
| `docs/`                           | Local architecture + API contract mirrors.                           |

## Actor Surface

Storage-service inherits the PFU-1 / CMS-API-KEY-ACTOR-1 actor contract
**byte-for-byte** from `xynes-accounts-service` and `xynes-cms-core`. The
gateway resolves the actor (user JWT or workspace API key) and forwards the
identity via well-known headers. Storage-service parses those headers and
builds `ActionContext.actor`.

### Headers forwarded by the gateway

| Header               | Required when          | Notes                                                       |
| -------------------- | ---------------------- | ----------------------------------------------------------- |
| `X-XS-Actor-Type`    | always                 | `user` or `api_key`. Defaults to `user` if absent.          |
| `X-XS-User-Id`       | actor type is `user`   | UUID v4.                                                    |
| `X-XS-API-Key-Id`    | actor type is `api_key`| UUID v4.                                                    |
| `X-XS-API-Key-Prefix`| actor type is `api_key`| Exactly 8 lowercase hex chars (first 8 chars of the secret).|
| `X-Workspace-Id`     | always                 | UUID v4. Storage has no anonymous routes.                   |
| `X-Request-Id`       | always                 | Propagated for log correlation.                             |

Malformed actor headers (e.g., non-UUID `X-XS-API-Key-Id`, prefix not 8 hex
chars, unknown `X-XS-Actor-Type`) are rejected with `400 INVALID_HEADER`
**before** any handler runs.

### `ActionContext.actor`

```ts
type UserActor = { kind: "user"; userId: string };
type ApiKeyActor = {
  kind: "api_key";
  apiKeyId: string;
  keyPrefix: string;
};
type ActionActor = UserActor | ApiKeyActor;

type ActionContext = {
  workspaceId: string;
  requestId: string;
  actor: ActionActor;
  // Legacy field; populated only when actor.kind === "user" for backwards
  // compatibility with handlers that have not migrated to ctx.actor.
  userId?: string;
};
```

**Raw API key material is never carried in `ActionContext`.** The gateway has
already verified the Argon2id hash and resolved the API key to its
`apiKeyId` + `keyPrefix` before forwarding. Storage-service must never
attempt to read `Authorization: Bearer xynes_live_...` directly.

### Defense-in-depth posture (matches CMS-API-KEY-ACTOR-1 Story B/C)

1. **Gateway enforces scope.** The route's `actionKey` is checked against the
   API key's `workspace_api_key_scopes` rows. A scope miss returns `403`
   before reaching storage-service.
2. **Storage-service enforces workspace ownership.** Every action handler
   verifies that the requested object/session/variant row belongs to
   `ctx.workspaceId`.
3. **Per-handler audit policy.** Writes performed by `api_key` actors leave
   `created_by` / `updated_by` columns NULL. Handlers that must record a
   human user identity gate with `requireUserActor(ctx)` and return
   `403 FORBIDDEN_ACTOR_KIND` for `api_key` actors.
4. **No app-local role logic.** Storage-service does not run its own role
   check. Role-to-action mapping lives entirely in `xynes-authz-service`.

## Planned Action Keys

All action keys are planned. Implementation lands across STORAGE-5..STORAGE-9.

| Action key                                  | Route family            | Story     |
| ------------------------------------------- | ----------------------- | --------- |
| `platform.storage.objects.upload`           | uploads create/complete/abort | STORAGE-5 |
| `platform.storage.objects.read`             | objects list/get/download-url | STORAGE-6 |
| `platform.storage.objects.delete`           | objects DELETE          | STORAGE-6 |
| `platform.storage.objects.process.retry`    | processing retry        | STORAGE-7 |
| `platform.storage.usage.read`               | usage read              | STORAGE-6 |
| `platform.storage.providers.manage`         | provider config         | STORAGE-3 / Workspace Admin UI |

**No public/anonymous actions.** Every action key in the table above requires
`X-Workspace-Id` plus an actor.

## Adding a New Action (TDD workflow) — `[planned — STORAGE-4 onward]`

Documented forward so STORAGE-5..STORAGE-9 can land features against a
predictable pattern (mirrors `xynes-accounts-service` and `xynes-cms-core`).

1. Write a failing unit test in `tests/` exercising the action via the
   internal envelope.
2. Add a Zod payload schema in `src/actions/schemas.ts` keyed by action key.
3. Add the handler in `src/actions/handlers/<family>/<action>.ts`. Inject
   repositories; do not import DB modules at the handler module scope.
4. Register the handler in `src/actions/registry.ts`.
5. If the action records audit columns (`created_by` / `updated_by`), gate
   with `requireUserActor(ctx)` or `getOptionalUserId(ctx)` per
   in-preset vs out-of-preset policy.
6. Run `bun run test`, `bun run lint`, `bun run typecheck`. All must pass
   before the PR is opened against `develop`.

## Security Notes

### Forbidden fields (storage-service must never write these to logs, responses, or DB columns)

The list below is the canonical set that `xynes-gateway` redaction must
recognise once storage-service starts emitting requests through it (lands
with STORAGE-9). All field names match regardless of case or `_`/`-` style.

| Field name family               | Reason                                  |
| ------------------------------- | --------------------------------------- |
| `accessKey` / `access_key`      | Provider IAM access key.                |
| `secretKey` / `secret_key`      | Provider IAM secret.                    |
| `r2Token` / `r2_token`          | Cloudflare R2 token.                    |
| `providerCredential` / `provider_credential` | Generic provider credential value. |
| `signedUrl` / `signed_url`      | Short-lived presigned URL — leaks bucket auth context. |
| `uploadUrl` / `upload_url`      | Same — presigned PUT URL.               |
| `downloadUrl` / `download_url`  | Same — presigned GET URL.               |
| `xynes_live_*` (raw API key)    | Already covered by gateway Task 6 redaction (workspace-admin epic). |
| `key_hash` / `keyHash`          | Argon2id hash — already covered, listed for completeness. |

Storage-service must:

- Never persist any of these in `platform.storage_*` tables (provider
  credentials are stored as **references** to a secret manager or runtime
  env alias).
- Never include these in action response payloads except where the
  client must consume the value once and immediately discard it (e.g.,
  the create-upload-session response returns a `uploadUrl` / `uploadHeaders`
  to the client — but the value is single-use, short-lived, and **never
  written to logs**).
- Never echo these in error envelopes.

### CORS — `[planned — STORAGE-9]`

CORS is limited to approved Xynes app origins. Storage-service does **not**
allow `*` origins for upload or download URLs.

### Upload session expiry — `[planned — STORAGE-5]`

Upload sessions expire quickly by default (concrete TTL set in STORAGE-5).
Abandoned multipart uploads are aborted by a cleanup job (STORAGE-9).

## Environment `[planned — STORAGE-2/3]`

Concrete env keys land with the compose + gateway wiring in STORAGE-2/3. The
following names are **reserved**:

| Env var                          | Purpose                                          |
| -------------------------------- | ------------------------------------------------ |
| `PORT`                           | Service HTTP port. **Reserved: `4204`** (next free after accounts-service `4203`; current allocation 4100 gateway, 4201 doc, 4202 cms-core, 4203 accounts, 4300 authz, 4400 telemetry). Operator confirms in STORAGE-2/3. |
| `DATABASE_URL`                   | Postgres connection string. Shared platform DB.  |
| `INTERNAL_SERVICE_TOKEN`         | Shared with gateway for `X-Internal-Service-Token` verification. |
| `STORAGE_PROVIDER_DEFAULT`       | `r2` for hosted, `local` for dev (MinIO).        |
| `R2_ACCOUNT_ID`                  | Cloudflare R2 account ID.                        |
| `R2_ACCESS_KEY_ID_REF`           | **Reference** to a secret manager entry, NOT the raw key. |
| `R2_SECRET_ACCESS_KEY_REF`       | **Reference** to a secret manager entry, NOT the raw secret. |
| `R2_BUCKET_DEFAULT`              | Default bucket name.                             |
| `STORAGE_MULTIPART_THRESHOLD_BYTES` | Default `104857600` (100 MB) per AWS guidance. |

The pattern of storing **references** (env aliases) rather than raw
credentials matches the workspace-admin-integrations contract for
`platform.workspace_storage_providers`.

## Out of scope for STORAGE-1

| Concern                                 | Owning story |
| --------------------------------------- | ------------ |
| Bun/Hono service scaffold (`src/`, `tests/`, `Dockerfile`, `package.json`) | STORAGE-4 |
| Postgres schema (`platform.storage_*` tables) | STORAGE-2 |
| Compose + `.env.dev` entries            | STORAGE-2 / STORAGE-3 |
| Gateway service-key allowlist + dynamic route seeds | STORAGE-3 |
| Authz permission catalog rows           | STORAGE-3 |
| api-docs entry under `Xynes-Studio/xynes-api-docs` | STORAGE-3 |
| Provider adapter implementations (R2 + local MinIO) | STORAGE-4 |
| Upload session create/complete/abort handlers | STORAGE-5 |
| Object metadata, signed reads, delete, usage | STORAGE-6 |
| Async processing queue + workers        | STORAGE-7 |
| Image/video/document processing profiles | STORAGE-8 |
| Security, privacy, abuse controls       | STORAGE-9 |
| CMS Console storage client              | STORAGE-10 |
| CMS content editor upload UX            | STORAGE-11 |
| Local smoke + rollout checklist         | STORAGE-12 |

## References

- Source plan (authoritative):
  `xynes-infra/docs/plans/2026-05-10-universal-object-storage-file-upload-api.md`
- Architecture epic:
  `xynes-infra/infra/architecture/epics/universal-object-storage.md`
- PFU-1 actor contract reference: `xynes-accounts-service/src/routes/internal.route.ts`,
  `xynes-accounts-service/src/actions/{types,guards,errors}.ts`.
- CMS-API-KEY-ACTOR-1 actor short-circuit reference:
  `xynes-cms-core/src/middleware/authz-check.ts`,
  `xynes-cms-core/src/middleware/actor-guards.ts`.
- Workspace-admin-integrations epic (sibling platform-level epic):
  `xynes-infra/infra/architecture/epics/workspace-admin-integrations.md`.
