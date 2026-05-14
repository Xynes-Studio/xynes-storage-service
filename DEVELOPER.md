# Xynes Storage Service — Developer Guide

> **Status: STORAGE-6 (object metadata, signed reads, delete, and usage handlers landed 2026-05-14).**
> STORAGE-5 (upload session lifecycle) landed 2026-05-13. STORAGE-6 adds the
> `platform.storage.objects.read` (`list` / `get` / `download_url`),
> `platform.storage.objects.delete`, and `platform.storage.usage.read`
> action keys. Handlers remain fully DI-driven against
> `ExtendedStorageObjectRepository`, `StorageVariantRepository`,
> `StorageProcessingJobRepository`, `StorageUsageRepository`, and
> `ExtendedStorageProviderResolver` interfaces — production wiring
> (Drizzle + the live R2 adapter) lands as a follow-up infra story.
> Async processing jobs land in STORAGE-7; storage-service-side log
> redaction in STORAGE-9; Docker compose wiring + MinIO container in
> STORAGE-12.

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

## Provider Adapter (STORAGE-4)

The S3-compatible provider adapter is the single seam between
storage-service and any object-storage backend. **One class, one code
path** — R2, Backblaze B2, iDrive e2, AWS S3, MinIO, and any future BYOS
bucket are configuration differences, not code differences.

### Adapter contract

```ts
import {
  S3StorageProviderAdapter,
  type ProviderAdapterConfig,
} from './infra/providers';

const adapter = new S3StorageProviderAdapter({
  providerKind: 'r2',
  endpoint: 'https://<ACCOUNT_ID>.r2.cloudflarestorage.com',
  region: 'auto',
  bucket: 'xynes-r2-prod',
  accessKeyId: resolved.accessKeyId,
  secretAccessKey: resolved.secretAccessKey,
});

const upload = await adapter.createSingleUploadUrl({
  objectKey: 'workspaces/abc/files/photo.png',
  contentType: 'image/png',
  contentLength: 1024,
});
// upload.url is a presigned PUT URL the browser uses directly.
```

### What the adapter enforces

| Invariant | Enforced by |
|---|---|
| Always SigV4 (AWS SDK v3 default) | SDK default; no `signatureVersion` override |
| NEVER emits `x-amz-tagging` on PUT / Copy | adapter code (B2 portability) |
| NEVER uses browser POST forms (always PUT presign) | adapter code |
| Multipart parts ∈ `[1, 10000]`, ETag required, no duplicates | adapter code |
| Presigned URLs signed against S3 endpoint host only | SDK default + matrix test guard |
| Presign expiry ∈ `[30 s, 7 days]` (SigV4 hard cap) | adapter code |
| Errors NEVER carry credentials / signature parameters | `runWithRedactedError` wrapper |
| Object keys ≤ 1024 bytes, no leading `/` | adapter code (portable across all 5 providers) |
| SSE-KMS NEVER set | adapter code (R2 / B2 / iDrive e2 don't support it) |
| CORS XML validated against B2's tightest limits | `validateCorsConfig` |

### Per-provider configuration cheatsheet

| Provider | `endpoint` | `region` | `forcePathStyle` |
|---|---|---|---|
| **Cloudflare R2** | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` | `auto` | `false` |
| **Backblaze B2** | `https://s3.<region>.backblazeb2.com` | real region (e.g. `us-east-005`) | `false` |
| **iDrive e2** | per-account console URL (only after region enablement) | real region | `false` |
| **AWS S3** | `https://s3.<region>.amazonaws.com` | real region | `false` |
| **MinIO (local dev)** | `http://minio:9000` | `us-east-1` by convention | `true` |

The adapter **never** derives `endpoint` / `region` / `forcePathStyle` from
`providerKind`. `providerKind` is the discriminator for the per-provider
quirks table in plan §3 and for the rollout checklist; it does NOT control
SDK behaviour.

### Testing the adapter

Tests use the `S3StorageProviderAdapterDeps` DI seam to inject fake
`S3Client` + fake `getSignedUrl` so no real provider is ever contacted:

```ts
const fakeClient = { send: async () => ({ UploadId: 'mp-1' }) };
const adapter = new S3StorageProviderAdapter(config, {
  createClient: () => fakeClient as never,
  presign: async () => 'https://fake-endpoint.example/key?X-Amz-Signature=…',
});
```

The matrix test (`tests/providers/multi-provider-matrix.test.ts`)
instantiates the adapter against fake R2, B2, iDrive e2, AWS S3, and MinIO
configurations and asserts identical request construction modulo the
provider quirks. Add new providers (e.g. Tigris) by adding a new entry to
the `PROVIDER_MATRIX` fixture — no adapter code change required.

## Upload Session Lifecycle (STORAGE-5)

The `platform.storage.objects.upload` action key is the single entry point
for upload-session lifecycle operations. The gateway funnels three routes
to this key:

- `POST /workspaces/:workspaceId/storage/uploads`
- `POST /workspaces/:workspaceId/storage/uploads/:uploadId/complete`
- `POST /workspaces/:workspaceId/storage/uploads/:uploadId/abort`

The storage-service distinguishes the three with a payload-level
`operation` discriminator: `'create' | 'complete' | 'abort'`. Each
operation is enforced by a strict Zod schema.

### Source layout

```
src/actions/handlers/uploads/
  schemas.ts        # Strict Zod schemas for the three operations.
  types.ts          # DTO + repository + resolver interfaces (DI).
  object-keys.ts    # Unguessable provider-key derivation.
  responses.ts      # Public DTO builders (documented-fields-only).
  create.ts         # Create-session handler factory.
  complete.ts       # Complete-session handler factory.
  abort.ts          # Abort-session handler factory.
  index.ts          # Dispatcher + `registerUploadActionHandlers(deps)`.
```

### Handler dependencies

Each handler factory takes a single `UploadHandlerDependencies` object:

```ts
interface UploadHandlerDependencies {
  readonly objects: StorageObjectRepository;
  readonly sessions: UploadSessionRepository;
  readonly providers: StorageProviderResolver;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly sessionTtlSeconds?: number;       // [60, 86400], default 900.
  readonly multipartThresholdBytes?: number; // Default 100 MiB.
}
```

- `StorageObjectRepository` and `UploadSessionRepository` are repository
  interfaces; production wiring (Drizzle against `platform.storage_*`)
  lands as a follow-up infra story when DB access lands in
  storage-service. Tests inject in-memory fakes.
- `StorageProviderResolver` resolves the workspace's default provider via
  `platform.workspace_storage_providers` and returns an instantiated
  `StorageProviderAdapter` (the STORAGE-4 adapter class).

### Security invariants enforced by the handlers

- **Strict schema validation.** Each payload is parsed with `.strict()`;
  unknown fields are rejected with `400 VALIDATION_ERROR` BEFORE the
  handler touches the DB or the provider.
- **Cross-workspace denial == not-found envelope.** Looking up a session
  that exists but belongs to a different workspace returns the same
  `ValidationError("Upload session not found")` as a truly-unknown
  session id. Hostile callers cannot probe other workspaces' session
  ids.
- **Workspace-scoped object keys.** Provider object keys follow the
  layout `workspaces/<workspaceId>/objects/<objectId>/<safeFilename>`.
  The `objectId` is a UUID v4 minted at create-session time (128 bits of
  entropy), and the workspace UUID prefix prevents cross-workspace
  enumeration at the bucket layout level. The `safeFilename` segment
  strips path separators, ASCII control chars, and provider-reserved
  chars; total key length is bounded to 1024 bytes (AWS S3 limit).
- **Atomic create-with-session.** The repository contract requires that
  the object row + upload-session row insert together. If the session
  insert fails AFTER the create handler minted a multipart upload on the
  provider, the handler issues a best-effort `AbortMultipartUpload`
  before re-throwing the ORIGINAL DB error — preventing orphan provider
  multipart uploads from accumulating on rollback.
- **Conditional state transitions.** `markCompletedIfPending` and
  `markAbortedIfPending` are conditional UPDATEs that match only
  `status = 'pending'` (and, for complete, only when `expires_at` is in
  the future). Race losers are resolved by re-reading the row and
  surfacing either an idempotent success (if the row reached the same
  terminal state) or a state-conflict envelope.
- **Idempotent terminal states.** Calling `complete` on an already-
  completed session, or `abort` on an already-aborted/expired session,
  returns the current state envelope WITHOUT re-touching the provider
  or the DB. This makes retries from the browser safe.
- **`createdBy` audit posture matches CMS-API-KEY-ACTOR-1 Story C.**
  Uploads performed by an `api_key` actor leave
  `storage_objects.created_by = NULL`. Uploads performed by a `user`
  actor populate it with the user UUID. Out-of-MVP-preset operations
  (e.g. `process.retry`, `usage.read`) gate on `requireUserActor` in
  later stories.
- **Provider abort is best-effort on `NoSuchUpload`.** The abort handler
  swallows `ProviderAdapterError` from `abortMultipartUpload` so a
  provider-side already-aborted multipart (the documented STORAGE-9
  cleanup-job behaviour) still flips the local DB row to `aborted`. A
  non-`ProviderAdapterError` (programming bug, network failure) is
  re-thrown.

### Response shape contract — documented fields only

Every handler returns a DTO shaped by `responses.ts`. The DTO is a strict
allowlist — `provider_kind`, `endpoint`, `region`, `bucket`,
`provider_object_key`, `provider_id`, `provider_upload_id`,
`credential_ref`, `accessKeyId`, `secretAccessKey`, and presigned URL
signature parameters do NOT appear as standalone fields. The signed
`uploadUrl` / `parts[].url` are opaque bearer tokens the caller sends
verbatim to the provider; their contents are not parsed by the caller.

Redaction is tested by:

1. Per-field allowlist assertions on every response shape.
2. Whole-response `JSON.stringify` regex sweeps that fail if any
   forbidden field name appears anywhere in the payload.

### Wiring handlers into the action registry

Production code wires the handlers with concrete repository
implementations:

```ts
// src/index.ts (planned wiring; lands when DB access does):
import { registerUploadActionHandlers } from './actions/handlers/uploads';
registerUploadActionHandlers({
  objects: new DrizzleStorageObjectRepository(db),
  sessions: new DrizzleUploadSessionRepository(db),
  providers: new DefaultStorageProviderResolver(db, secretManager),
});
```

For STORAGE-5 the registry is still empty in `src/index.ts` — the unit
tests register handlers against in-memory fakes. The `registerUploadActionHandlers`
function is exported so production wiring is a one-liner.

## Object Metadata, Signed Reads, Delete, and Usage (STORAGE-6)

STORAGE-6 adds three action keys (registered together via
`registerObjectActionHandlers(deps)`):

| Action key                            | Operations (payload `operation` discriminator) | Gateway routes                                                          |
| ------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------- |
| `platform.storage.objects.read`       | `list` / `get` / `download_url`                | `GET /storage/objects`, `GET /storage/objects/:objectId`, `POST /storage/objects/:objectId/download-url` |
| `platform.storage.objects.delete`     | `delete`                                       | `DELETE /storage/objects/:objectId`                                     |
| `platform.storage.usage.read`         | `usage`                                        | (deferred per STORAGE-3 plan §8 "future preset keys")                   |

### Source layout

```
src/actions/handlers/objects/
  schemas.ts        # Strict Zod schemas + the MIME->family classifier.
  cursor.ts         # Opaque base64url-JSON keyset cursor codec.
  types.ts          # Extended repositories + resolver + DTO records.
  responses.ts      # Public DTO builders (documented-fields-only).
  list.ts           # `platform.storage.objects.read` → `list`.
  get.ts            # `platform.storage.objects.read` → `get`.
  download-url.ts   # `platform.storage.objects.read` → `download_url`.
  delete.ts         # `platform.storage.objects.delete` → `delete`.
  usage.ts          # `platform.storage.usage.read` → `usage`.
  index.ts          # Dispatchers + `registerObjectActionHandlers(deps)`.
```

### Handler dependencies

```ts
interface ObjectsHandlerDependencies {
  readonly objects: ExtendedStorageObjectRepository;   // find / list / soft-delete
  readonly variants: StorageVariantRepository;          // list variants per object
  readonly jobs: StorageProcessingJobRepository;        // list processing jobs per object
  readonly usage: StorageUsageRepository;               // read pre-aggregated daily rows
  readonly providers: ExtendedStorageProviderResolver;  // resolveDefault + resolveByProviderId
  readonly now?: () => Date;
  readonly defaultDownloadTtlSeconds?: number;          // [30, 3600], default 900.
  readonly defaultListLimit?: number;                   // default 50, max 200.
}
```

Tests inject in-memory fakes (`tests/actions/handlers/objects/_fakes.ts`).
Production wiring (Drizzle repositories + secret-manager-backed provider
resolver) lands as a follow-up infra story.

### Security invariants enforced by the STORAGE-6 handlers

- **Workspace ownership is enforced at the repository layer.** Every
  query is scoped to `ctx.workspaceId`; the handler never accepts a
  workspaceId on the payload. Cross-workspace probes always return the
  "Object not found" envelope.
- **Soft-delete is the canonical delete contract.** The row flips to
  `status = 'deleted'` and `deleted_at` is stamped; the row is preserved
  for audit. List endpoints filter out `deleted` rows defensively even
  if the repo returned them. Get / download-url against a `deleted`
  object returns the same "Object not found" envelope as a never-existed
  object — soft-deletion is indistinguishable from never-existed on the
  wire.
- **Download URLs are signed against the object's recorded `providerId`,
  not the workspace default.** This ensures that an object created on
  Provider A still resolves correctly after the workspace flips its
  default to Provider B. The resolver miss surfaces as `403 ForbiddenError`
  with a deliberately generic message that does NOT leak provider config.
- **Download-URL response is exactly `{ objectId, url, expiresAt }`.**
  No other field. The `url` embeds the SigV4 signature opaquely; the
  caller treats it as a bearer token.
- **Soft-delete is best-effort against the provider.**
  `ProviderAdapterError` from `deleteObject` is swallowed (the local DB
  row is the source of truth; the cleanup job reconciles orphans later).
  A non-`ProviderAdapterError` is re-thrown but only AFTER the DB row
  has flipped — the local soft-delete is the authoritative record.
- **Download-URL filename input is CRLF / quote-stripped.**
  `downloadFilename` is rejected by the schema if it contains CR/LF or
  `"` characters — defense-in-depth on top of the STORAGE-4 adapter's
  own header-injection guard.
- **List filters are enum-bounded.** `purpose` is snake_case, `status`
  is an explicit allowlist (`deleted` is excluded), `contentTypeFamily`
  is an enum. A hostile caller cannot inject regex-like or unbounded
  values.
- **Opaque keyset cursor.** The list response carries an opaque
  base64url-encoded JSON cursor. Decoding validates the inner shape
  (ISO-8601 timestamp + UUID) and rejects malformed inputs with
  `400 VALIDATION_ERROR`. The cursor deliberately does NOT carry the
  workspace id — workspace scoping happens at the repo layer.
- **Usage data is read from pre-aggregated rows.** The
  `StorageUsageRepository` contract requires the repo to read from
  `platform.storage_usage_daily` only; it MUST NOT scan
  `storage_objects` at request time. The handler caps the date range to
  366 days so a hostile caller cannot ask for years of daily data.
- **Per-provider rows are collapsed before the wire.** The usage
  response builder sums egress + ops across providers for the same date
  and takes the max stored bytes; `providerKind` never appears in the
  response.

### Response shape contract — documented fields only

Same posture as STORAGE-5: every DTO is an explicit allowlist. The
following fields are tested ABSENT (per-field allowlist + whole-response
`JSON.stringify` regex sweeps for every provider variant — R2 / B2 /
iDrive e2 / AWS S3 / MinIO):

- `provider_kind` / `providerKind`
- `providerId`
- `providerObjectKey` / `provider_object_key`
- `credential_ref` / `credentialRef`
- `endpoint` / `region` / `bucket`
- `accessKeyId` / `secretAccessKey`
- presigned-URL signature parameters

### Wiring handlers into the action registry

Production code wires the three action keys with concrete repositories:

```ts
// src/index.ts (planned wiring; lands when DB access does):
import { registerObjectActionHandlers } from './actions/handlers/objects';
registerObjectActionHandlers({
  objects: new DrizzleExtendedStorageObjectRepository(db),
  variants: new DrizzleStorageVariantRepository(db),
  jobs: new DrizzleStorageProcessingJobRepository(db),
  usage: new DrizzleStorageUsageRepository(db),
  providers: new DefaultStorageProviderResolver(db, secretManager),
});
```

For STORAGE-6 the registry is still empty in `src/index.ts` — the unit
tests register handlers against in-memory fakes. The
`registerObjectActionHandlers` function is exported so production wiring
is a one-liner once the Drizzle implementations land.
