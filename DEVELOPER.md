# Xynes Storage Service — Developer Guide

> **Status: STORAGE-12 (local smoke, docs, and rollout checklist landed 2026-05-14).**
> STORAGE-9 (security, privacy, and abuse controls) landed 2026-05-14.
> STORAGE-12 wires the storage-service container into
> `xynes-infra/docker-compose.dev.yml`, ships a provider-parameterised
> live smoke harness (`xynes-infra/scripts/smoke-universal-storage.sh`)
> defaulted to `STORAGE_SMOKE_PROVIDER=r2` (with opt-in `minio` / `b2` /
> `idrive_e2` support — MinIO is operator-ad-hoc, NOT bundled in compose),
> a cleanup script (`xynes-infra/scripts/cleanup-universal-storage.sh`)
> for stale pending sessions, the provider-parameterised rollout checklist
> at `xynes-infra/docs/runbooks/universal-storage-rollout-checklist.md`,
> and a static validator at
> `xynes-infra/scripts/test/smoke-universal-storage.test.sh` wired into
> `scripts/test/run.sh`. Earlier stories: STORAGE-5/6/7/8/9 in this repo,
> STORAGE-10 (CMS Console storage client) + STORAGE-11 (CMS editor upload
> UX + Lumia DS `objectId` support) in the frontend repos. Live runtime
> hook-up of the STORAGE-5/6/7 repository contracts against Drizzle +
> `platform.workspace_storage_providers` (i.e. the "registerActions"
> follow-up story) is **out of scope for STORAGE-12** — the harness +
> docs ship now so the rollout gate is documented and exercisable the
> moment that wiring lands.

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

The list below is the canonical set the storage-service-side redactor
(`src/infra/redaction.ts`, landed with STORAGE-9) and the gateway-side
redaction (Task 5 / Task 6) both recognise. All field names match
regardless of case or `_`/`-` style.

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

### CORS — `[STORAGE-9 — landed 2026-05-14]`

CORS is limited to approved Xynes app origins. Storage-service does **not**
allow `*` origins for upload or download URLs. The normalised internal
`CorsConfig` shape (`src/infra/providers/cors-validator.ts`) is serialised
per provider by `src/infra/providers/cors-serialiser.ts`:

- XML for R2 / Backblaze B2 / AWS S3 / MinIO / `s3_generic`.
- JSON for iDrive e2 (per-bucket "Bucket CORS" tab).

Both formats re-validate against B2's binding constraint (≤ 100 KB
serialised payload, `MaxAgeSeconds ∈ [0, 86400]`, non-empty
`AllowedOrigin`) so the same input is acceptable on every provider
without per-caller branching.

### Upload session expiry — `[STORAGE-5 + STORAGE-9 — both landed]`

Upload sessions expire quickly by default (concrete TTL set in STORAGE-5).
Abandoned multipart uploads are aborted by the
`AbandonedUploadCleanup` worker
(`src/infra/cleanup/abandoned-uploads.ts`, STORAGE-9). The worker calls
provider `AbortMultipartUpload` against the recorded `provider_kind`
and treats `NoSuchUpload` / `ProviderAdapterError` as success (provider
already cleaned up). Non-adapter errors defer the session for next
cycle so a transient infra failure does not strand the local row.

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

## Async Processing Queue + Worker (STORAGE-7)

STORAGE-7 introduces the async processing path that runs AFTER an upload
completes. The path is decomposed into four pure, DI-friendly modules:

1. **Planner** (`src/actions/handlers/processing/planner.ts`) — pure
   function that maps `(contentType, compressionRequested, status)` to a
   deterministic `ProcessingJobPlan[]`. Side-effect-free. Yields
   `scan_validation` for every upload (required), `image_optimize` for
   compression-enabled images (non-required), `video_probe` (required) +
   `video_thumbnail` + `video_transcode` (non-required) for compression-
   enabled videos, `document_preview` for the safe document MIME
   allowlist (non-required). Audio / archives / text / unknown content
   get scan-only.
2. **Aggregator** (`src/actions/handlers/processing/aggregator.ts`) —
   pure function from a job-list to the parent object's aggregate
   `ObjectStatus`. `processing` while ≥1 required job is queued/running;
   `failed` when ≥1 required job is terminally failed; `ready` when all
   required jobs are succeeded (or non-blocking terminal). Non-required
   jobs NEVER block `ready` and NEVER flip the parent to `failed`.
3. **Enqueue helper** (`src/actions/handlers/processing/enqueue.ts`) —
   runs the planner, inserts the job batch via the queue repo, flips the
   parent object to `processing`. Used by the upload-complete handler
   via the optional `enqueueProcessing` callback hook on
   `UploadHandlerDependencies`.
4. **Worker engine** (`src/actions/handlers/processing/worker.ts`) —
   polling loop that claims `queued` jobs atomically, dispatches them
   via the per-`jobType` `JobRunner` registry, applies retry / dead-
   letter logic, and updates the parent aggregate after each terminal
   transition.

### Action key

- `platform.storage.objects.process.retry` — discriminator
  `{ operation: 'retry', objectId: <UUID> }`. Requeues every
  terminally-failed job for the object, then recomputes + applies the
  aggregate status. Cross-workspace probes and soft-deleted objects
  return the same `"Object not found"` envelope as truly-unknown ids.

### Worker concurrency model

- **Global cap** (`maxConcurrent`, default `4`) — bounds how many jobs
  the worker drives in parallel per `runOnce()` pass.
- **Per-workspace cap** (`maxConcurrentPerWorkspace`, default `2`) — a
  single workspace cannot starve siblings. Claims beyond the cap are
  released back to `queued` with a 1 s backoff and `errorCode =
  PER_WORKSPACE_CAP` so another pass (or another worker) can pick them
  up.
- **Atomic claim contract** — production Drizzle implementations of
  `claimNextQueuedJob` MUST use `SELECT … FOR UPDATE SKIP LOCKED` (or
  equivalent) so two workers cannot claim the same row.

### Retry policy

- **Max attempts** (`maxAttempts`, default `3`, including the first).
- **Retryable failure < maxAttempts** → requeue with `now +
  retryBackoffSeconds` (default `60 s`), increment `attempts`.
- **Retryable failure at maxAttempts** → terminal `failed` (dead-
  lettered).
- **Non-retryable failure** → terminal `failed` immediately.
- **`RunnerNotImplementedError`** (no runner registered for the job
  type) → required jobs go terminal `failed` (`RUNNER_MISSING`); non-
  required jobs retry-then-dead-letter so a missing best-effort runner
  doesn't ruin an otherwise-good upload.
- **Parent object `deleted` / missing** → cancel the job
  (`OBJECT_NOT_AVAILABLE`, terminal) without touching the aggregate.

### Security invariants

- **No provider config / credential leakage in job payloads**. The
  planner emits ONLY `{ contentType, byteSize? }`. The job runner
  resolves the provider via the resolver at run-time using the parent
  object's recorded `providerId` (NOT the job payload). Tests assert
  the serialised payload never contains `provider*` / `endpoint` /
  `region` / `bucket` / `accessKey` / `secretAccess` / `credential` /
  `providerObjectKey` substrings.
- **Opaque `errorCode` strings only.** The worker NEVER bubbles up raw
  runner exception messages — those are caught and replaced with
  closed-set codes (`RUNNER_THREW`, `RUNNER_MISSING`, `RUNNER_FAILED`,
  `OBJECT_NOT_AVAILABLE`, `PER_WORKSPACE_CAP`, or whatever the runner
  returns in `result.errorCode`). Runner implementations are responsible
  for redacting provider-side details BEFORE returning.
- **Workspace ownership at every step.** The retry handler enforces
  workspace ownership on the object lookup AND every queue call. The
  worker's repo contract requires `claimNextQueuedJob` to return the
  workspace id so the worker can ALWAYS pass it back on every
  subsequent call (no cross-workspace state leak through job id alone).
- **Response shape allowlist.** The retry handler returns ONLY
  `PublicProcessingJob` + `PublicStorageObject` DTOs — no
  `providerObjectKey`, `providerId`, `provider_kind`, `endpoint`,
  `region`, `bucket`, `credential_ref`, `accessKeyId`, or
  `secretAccessKey` fields appear in the response. Verified by a
  whole-response `JSON.stringify` regex sweep test.

### Wiring the queue into upload-complete

The STORAGE-5 upload-complete handler now accepts an optional
`enqueueProcessing: (input) => Promise<readonly unknown[]>` callback on
`UploadHandlerDependencies`. When set, the complete handler invokes the
callback AFTER markUploaded and forwards the returned job DTOs to the
`processingJobs` field of the response. When unset (STORAGE-5 default),
`processingJobs` is `[]` (the prior behaviour). A thrown callback is
SWALLOWED — the upload-complete success is not undone. Example:

```ts
import { createCompleteUploadHandler } from './actions/handlers/uploads/complete';
import { enqueueProcessingForObject } from './actions/handlers/processing/enqueue';
import { ProcessingWorker, registerProcessingActionHandlers } from './actions/handlers/processing';

const handler = createCompleteUploadHandler({
  objects: drizzleObjectRepo,
  sessions: drizzleSessionRepo,
  providers: liveProviderResolver,
  enqueueProcessing: async ({ objectId, workspaceId }) => {
    const object = await drizzleObjectRepo.findByIdForWorkspace({ objectId, workspaceId });
    if (!object) return [];
    const result = await enqueueProcessingForObject(
      { queue: drizzleQueueRepo, status: drizzleStatusRepo },
      object,
    );
    return result.jobs;
  },
});

// Worker boot
const worker = new ProcessingWorker({
  queue: drizzleQueueRepo,
  status: drizzleStatusRepo,
  findObject: ({ objectId, workspaceId }) =>
    drizzleObjectRepo.findByIdForWorkspace({ objectId, workspaceId }),
  runners: {
    scan_validation: liveScanRunner, // STORAGE-8 or no-op-scanner in local dev
    image_optimize: liveImageRunner,
    // ...etc
  },
});
worker.start(1000);

// Retry action handler
registerProcessingActionHandlers({
  queue: drizzleQueueRepo,
  status: drizzleStatusRepo,
  objects: { findByIdForWorkspace: drizzleObjectRepo.findByIdForWorkspace.bind(drizzleObjectRepo) },
});
```

For STORAGE-7 the action registry remains empty in `src/index.ts` — the
unit tests register handlers against in-memory fakes. The
`registerProcessingActionHandlers` function is exported so production
wiring is a one-liner once the Drizzle implementations land.

### Image, Video, and Document Processing Profiles (STORAGE-8)

Source layout under `src/actions/handlers/processing/runners/`:

| File | Purpose |
|---|---|
| `errors.ts` | Closed-set runner error codes (`PROFILE_GUARD_REJECTED`, `OVER_MAX_BYTES`, `OVER_MAX_DIMENSIONS`, `OVER_MAX_DURATION`, `UNSUPPORTED_FORMAT`, `MALWARE_DETECTED`, `SCANNER_INCONCLUSIVE`, `PROCESSOR_FAILED`) plus `RunnerInputError` (non-retryable) and `RunnerExecutionError` (retryable) classes. |
| `profiles.ts` | Named quality profiles (`balanced`, `high_quality`, `storage_saver`) for image + video; per-family hard caps (`MAX_IMAGE_BYTES=50MiB`, `MAX_VIDEO_BYTES=2GiB`, `MAX_DOCUMENT_BYTES=100MiB`, `MAX_IMAGE_DIMENSION=16384`, `MAX_VIDEO_DIMENSION=4096`, `MAX_VIDEO_DURATION_SECONDS=3600`); safe document MIME allowlist. |
| `ports.ts` | DI port contracts: `ProviderObjectIO`, `StorageVariantWriter`, `ImageProcessor`, `VideoProcessor`, `DocumentProcessor`, `MalwareScanner`. Plus `noopMalwareScanner` for local dev. |
| `variant-keys.ts` | `deriveVariantObjectKey({...})` — variant keys land under `<parent-dir>/variants/<role>.<ext>`. Asserts non-collision with the parent key. |
| `runner-utils.ts` | `runRunnerWithErrorMapping(fn)` — translates `RunnerInputError` / `RunnerExecutionError` into `JobRunResult` shapes the worker understands; re-throws unexpected errors so the STORAGE-7 worker layer applies its `RUNNER_THREW` redaction. |
| `scan-validation.ts` | `createScanValidationRunner({providerIO, scanner})`. REQUIRED. Enforces per-family hard byte cap, then scans via injected `MalwareScanner`. Verdicts: `clean` → success; `infected` → `MALWARE_DETECTED` non-retryable; `unknown` → `SCANNER_INCONCLUSIVE` retryable. |
| `image.ts` | `createImageOptimizeRunner({providerIO, processor, variants})`. Non-required. Reads payload `qualityProfile` (defaults to `balanced`), enforces hard byte + dimension caps, then renders every variant for the active profile and writes each under a derivative key (never overwriting the original). |
| `video.ts` | `createVideoProbeRunner`, `createVideoThumbnailRunner`, `createVideoTranscodeRunner`. Probe is REQUIRED — duration + dimension caps live here so thumbnail / transcode never burn worker time on over-cap inputs. Transcode writes H.264/AAC MP4 ONLY (per STORAGE-8 acceptance criteria). |
| `document.ts` | `createDocumentPreviewRunner({providerIO, processor, variants})`. Non-required. Defense-in-depth allowlist re-check on top of the STORAGE-7 planner. Preview is always image/png or image/jpeg — never the original document format. |
| `registry.ts` | `createRunnerRegistry(deps)` returns `Partial<Record<ProcessingJobType, JobRunner>>` for `ProcessingWorker.runners`. Every job type the STORAGE-7 planner can emit has a runner. |
| `index.ts` | Barrel re-exports. |

#### Security invariants enforced by tests

- Runners NEVER receive the raw `StorageProviderAdapter` — only the narrow `ProviderObjectIO` port (read + write only). They cannot mint signed URLs or initiate multipart uploads, which scopes their blast radius.
- Runners NEVER overwrite the original `providerObjectKey`. The variant-key deriver asserts non-collision; every provider write uses `ifAbsent: true`.
- Runners NEVER embed raw provider / library / processor error text into surfaced error codes. Closed-set codes only.
- The scan/validation runner refuses to coerce a `unknown` verdict to "best-effort clean" — transient scanner outages retry, not pass.
- EXIF stripping (including GPS) is the `ImageProcessor` port's contractual responsibility — documented invariant on `renderVariant`.

#### Production wiring example

```ts
import { ProcessingWorker, createRunnerRegistry } from './actions/handlers/processing';
import { sharpImageProcessor } from './infra/processors/sharp-image';   // future infra story
import { ffmpegVideoProcessor } from './infra/processors/ffmpeg-video'; // future infra story
import { libreofficeDocumentProcessor } from './infra/processors/libreoffice-document';
import { drizzleVariantWriter } from './infra/db/drizzle-variant-writer';
import { adapterToProviderIO } from './infra/providers/adapter-to-provider-io';
import { clamavScanner } from './infra/scanners/clamav';

const runners = createRunnerRegistry({
  providerIO: adapterToProviderIO(workspaceProviderAdapter),
  variants: drizzleVariantWriter,
  scanner: clamavScanner,
  image: sharpImageProcessor,
  video: ffmpegVideoProcessor,
  document: libreofficeDocumentProcessor,
});

const worker = new ProcessingWorker({ queue, status, findObject, runners });
worker.start();
```

For STORAGE-8 the action registry remains empty in `src/index.ts` —
the unit tests register handlers and runners against in-memory fakes.
The `createRunnerRegistry` factory is exported so production wiring
is a one-liner once sharp / ffmpeg / libreoffice / clamav bindings (or remote
sidecars) plus the Drizzle variant writer land.

## Security, Privacy, and Abuse Controls (STORAGE-9)

STORAGE-9 lands three storage-service-side defense-in-depth modules
that the gateway-level Task 5 telemetry redaction + Task 6 snippet
redaction already cover, plus the per-provider CORS push contract and
the abandoned-upload cleanup job:

### Storage-side log redaction (`src/infra/redaction.ts`)

Mirrors the gateway's three-tier field-name strategy and extends it
to cover SigV4 presigned URL signature parameters + storage provider
credential surfaces. Every `logger.info` / `.warn` / `.error` /
`.debug` call routes through this module before the JSON line is
emitted, so a handler that mistakenly passes a `secretAccessKey` /
`credentialRef` / `r2Token` / raw `xynes_live_<hex>` API key as a
log field gets the value replaced with `[REDACTED]` automatically.

Field-name match tiers:
- **Loose substring** — `authorization`, `cookie`, `set-cookie`,
  `password`, `token`, `secret`, `x-internal-service-token`,
  `x-amz-signature`, `x-amz-credential`, `x-amz-security-token`,
  `x-amz-date`, `x-amz-expires`, `x-amz-signedheaders`.
- **Anchored exact** — `apiKey`, `api_key`, `api-key`, `x-xs-api-key`,
  `rawKey`, `raw_key`, `keyHash`, `key_hash`, `accessKeyId`,
  `access_key_id`, `secretAccessKey`, `secret_access_key`,
  `credentialRef`, `credential_ref`, `r2Token`, `r2_token`.
- **Compound `apikey` substring** — covers `x-api-key`,
  `workspaceApiKey`, etc., safelisted by the `Id` / `Prefix` suffix
  so public audit handles (`apiKeyId`, `keyPrefix`) stay readable.

Free-text scrubbing (applied to every string field + log message):
`Bearer <token>`, quoted authorization / cookie / x-xs-api-key /
x-amz-signature headers, raw `xynes_live_<hex>` API keys, Argon2
hashes (`$argon2id$...`), and SigV4 presigned URL signature query
parameters (`X-Amz-Signature=...`, `X-Amz-Credential=...`,
`X-Amz-Security-Token=...`, `X-Amz-Date=...`, `X-Amz-Expires=...`,
`X-Amz-SignedHeaders=...`).

The redactor preserves storage-specific audit handles that operators
need: `objectId`, `workspaceId`, `requestId`, `actionKey`,
`actorType`, `routeId`, `providerId` (UUID), `providerKind`,
`uploadId`, `sessionId`, `jobId`, `variantId`, `role`, `status`,
`filename`, `contentType`, `byteSize`.

### Per-provider CORS serialiser (`src/infra/providers/cors-serialiser.ts`)

Accepts the normalised internal `CorsConfig` from
`cors-validator.ts` and emits the wire format each provider expects:

- **R2 / Backblaze B2 / AWS S3 / MinIO / `s3_generic`**: AWS S3 CORS
  XML (`<CORSConfiguration>...<CORSRule>...`).
- **iDrive e2**: JSON matching the per-bucket "Bucket CORS" tab in
  the e2 console — `{ "CORSRules": [{ "AllowedOrigins": [...],
  "AllowedMethods": [...], ... }] }`.

The serialiser runs shape validation BEFORE serialisation, then
re-validates the byte length AGAINST B2's binding constraint (100 KB
payload cap) so the same input is acceptable on every provider
without per-caller branching. XML output escapes reserved chars (`<`,
`>`, `&`, `"`, `'`) in origins and headers. The output NEVER carries
provider credentials (it can't — the function takes a normalised
`CorsConfig` only — but a regression test guards that invariant).

`wireFormatForProvider(providerKind)` returns `'json'` for
`idrive_e2` and `'xml'` for everything else.

### Abandoned upload cleanup (`src/infra/cleanup/abandoned-uploads.ts`)

`AbandonedUploadCleanup` is the storage-service equivalent of
STORAGE-7's `ProcessingWorker` — a DI-driven background worker with
a deterministic `runOnce()` for tests and a `start(intervalMs)` /
`stop()` polling loop for production. Each pass:

1. `listExpiredPending({ now, limit })` against the cleanup-specific
   repository contract (`AbandonedUploadSessionRepository`).
2. For each pending session past its `expires_at`:
   - If multipart with a `providerUploadId`: resolve the provider for
     the session's OWN workspace (cross-workspace isolation
     guaranteed by per-session resolution), call
     `abortMultipartUpload`. **`ProviderAdapterError` is SWALLOWED`
     (`NoSuchUpload` / already-aborted multiparts are treated as
     success — same posture as the per-request abort path in
     `abort.ts`). **Non-adapter errors DEFER the session** — the
     local row stays `pending` and we retry next cycle.
   - Mark the session `expired` via
     `markExpiredIfPending({ sessionId, workspaceId, now })`. A
     conditional-update miss (raced to `completed` / `aborted` /
     `expired`) is logged and counted as `raced`, not an error.
3. Return `{ scanned, expired, deferred, raced }` so callers can
   observe progress without trusting log scraping.

Polling loop swallows `runOnce` errors so a transient DB or provider
outage does NOT kill the cleanup process. The composition root
(`src/index.ts` follow-up) wires the cleanup against the Drizzle
session repo + the production provider resolver:

```ts
const cleanup = new AbandonedUploadCleanup({
  sessions: drizzleAbandonedSessionsRepo,
  objects: drizzleObjectRepo,
  providers: postgresWorkspaceStorageProviderResolver,
});
cleanup.start(); // default 60 s interval
```

For STORAGE-9 the action registry remains empty in `src/index.ts` —
production wiring lands with the follow-up infra story that ships
the Drizzle implementations (same posture as STORAGE-5..STORAGE-8).

### Story status

| Story | Status |
|---|---|
| STORAGE-1 | ✅ Landed 2026-05-13 |
| STORAGE-2 | ✅ Landed 2026-05-13 |
| STORAGE-3 | ✅ Landed 2026-05-13 |
| STORAGE-4 | ✅ Landed 2026-05-13 |
| STORAGE-5 | ✅ Landed 2026-05-13 |
| STORAGE-6 | ✅ Landed 2026-05-14 |
| STORAGE-7 | ✅ Landed 2026-05-14 |
| STORAGE-8 | ✅ Landed 2026-05-14 |
| STORAGE-9 | ✅ Landed 2026-05-14 |
| STORAGE-10 | ✅ Landed 2026-05-14 (CMS Console — `xynes-cms-console-web`) |
| STORAGE-11 | ✅ Landed 2026-05-14 (CMS editor + Lumia DS) |
| STORAGE-12 | ✅ Landed 2026-05-14 |
| STORAGE-FU-1 | ✅ Landed 2026-05-15 (Drizzle schema mirror + DB client + drift check) |
| STORAGE-FU-2 | ✅ Landed 2026-05-15 (Postgres repositories) |
| STORAGE-FU-2-FU-1 | ✅ Landed 2026-05-28 (Partial unique index `storage_processing_jobs_active_unique_uidx` on `(object_id, job_kind) WHERE status IN ('queued','running')` as belt-and-braces for `enqueueBatch` — DB-side 23505 translated to `DuplicateActiveJobError`) |
| STORAGE-FU-2-FU-2 | ✅ Landed 2026-05-29 (Persisted `payload jsonb NOT NULL DEFAULT '{}'::jsonb` + `required boolean NOT NULL DEFAULT true` columns on `storage_processing_jobs`; deleted TS-side `REQUIRED_BY_JOB_TYPE` lookup; added per-jobType Zod `.strict()` payload validators that reject hostile keys BEFORE the INSERT) |
| STORAGE-FU-2-FU-3 | ✅ Landed 2026-05-29 (CI Postgres service container — `supabase/postgres:17.4.1.018` + Supabase-CLI-style migration application via `psql` + new `integration-db` job parallel to `quality-gates` and `integration-processors`; `connectOrSkip()` honours `STORAGE_INTEGRATION_DB_REQUIRED=1` as a credential-sanitized hard-fail) |
| STORAGE-FU-2-FU-4 | ✅ Landed 2026-05-29 (DRY content-type-family prefix mapping — extracted `CONTENT_TYPE_FAMILY_PREFIXES` constant + derived 'other' branch exclusion list from `Object.values(...).flat()`; pure refactor, behavioural lock via existing `contentTypeFamily=other` integration test) |
| STORAGE-FU-3 | ✅ Landed 2026-05-15 (Provider resolver + secret-manager interface) |
| STORAGE-FU-4 | ✅ Landed 2026-05-15 (Composition root — handler registration + ready event) |
| STORAGE-FU-5 | ✅ Landed 2026-05-15 (Production runners — stub-mode default + S3 IO + variant writer + production-stub processors) |
| STORAGE-FU-5-FU-A | ✅ Landed 2026-05-28 (Sharp-backed `ImageProcessor` — closes Bug 1 for image variants; EXIF stripping mandatory; libvips cache disabled) |
| STORAGE-FU-5-FU-B | ✅ Landed 2026-05-28 (ffmpeg-backed `VideoProcessor` — closes Bug 1 for video variants; `-map_metadata -1` strips embedded metadata; pipe-only I/O with no temp files; `STORAGE_FFMPEG_TIMEOUT_MS` per-job timeout; in-process Bun.spawn against `ffmpeg-static`) |
| STORAGE-FU-5-FU-C | ✅ Landed 2026-05-28 (LibreOffice-backed `DocumentProcessor` — closes Bug 1 for document preview variants; HTTP client to pod-local sidecar via `LIBREOFFICE_SERVICE_URL`; `STORAGE_SOFFICE_TIMEOUT_MS` per-job timeout; safe-fail to production stub when URL unset) |
| STORAGE-FU-5-FU-D | ✅ Landed 2026-05-29 (ClamAV-backed `MalwareScanner` — closes STORAGE-9 §3.6 malware-scan gate; clamd INSTREAM over TCP (`CLAMD_HOST`/`CLAMD_PORT`) or unix socket (`CLAMD_SOCKET`); pooled persistent socket with reconnect-on-close; `unknown` NEVER coerced to `clean`; safe-fail to unknown scanner when ctor throws) |
| STORAGE-FU-5-FU-E | ✅ Landed 2026-05-28 (Deployment posture decision — sharp + ffmpeg in-process, LibreOffice + clamav sidecars; Compose overlay + K8s draft manifests) |
| STORAGE-FU-5-FU-F | ✅ Landed 2026-05-29 (Fixture-based integration suite under `tests/integration/processors/` — committed `sample.jpg`/`sample.png`/`sample.mp4`/`sample.pdf`/`eicar.txt` fixtures + per-processor suites with `describeIfBinary`/`describeIfEnv` soft-skip gates + new `integration-processors` CI job with `STORAGE_INTEGRATION_PROCESSORS_REQUIRED=1`) |
| STORAGE-FU-5-FU-G | ✅ Code landed 2026-05-28 (LibreOffice sidecar Bun HTTP shim image — closes Bug 1 (document) production gap. Source lives at `sidecars/libreoffice/` in this repo; Compose overlay + K8s manifests in `xynes-infra` pin to `xynes/libreoffice-sidecar:0.1.0`. Image build + live R2 smoke deferred to operator per plan §12.5 acceptance criteria.) |
| STORAGE-FU-6 | ✅ Landed 2026-05-16 (Worker lifecycle — `startLifecycle` + SIGTERM/SIGINT graceful shutdown + worker-cap env knobs) |
| DEDUP-1 | ✅ Landed 2026-05-28 (Content-hash dedup schema — `platform.storage_object_references` reference-counting join table + workspace-scoped partial unique index on `storage_objects (workspace_id, sha256)`) |
| DEDUP-2 | ✅ Landed 2026-05-28 (Content-hash dedup handler short-circuit + reference-counted soft-delete + CMS Console storage-client wiring) |
| STORAGE-LIVE-1 | ✅ Landed 2026-05-16 (R2 dev bucket + lifecycle + CORS + credential reference) |
| STORAGE-LIVE-2 | ✅ Landed 2026-05-16 (`platform.workspace_storage_providers` R2 dev seed migration + bootstrap wiring) |
| STORAGE-LIVE-3 | ✅ Landed 2026-05-27 (Live `--full` smoke evidence: PASS 13 / FAIL 0 against R2 dev) |
| STORAGE-LIVE-4 | ✅ Landed 2026-05-27 (CMS editor browser smoke: PASS 9 / FAIL 0 against R2 dev; render-loop + dragdrop/paste objectId fixes shipped on the same branch) |
| STORAGE-LIVE-5 | ✅ Landed 2026-05-27 (`cms_editor_storage_uploads` feature flag — gateway-architecture via `@xynes/auth-sdk` + `posthog-node` server-side) |
| STORAGE-LIVE-6 | ❌ Deferred 2026-05-27 — Hosted-alternate runbook (B2 / iDrive e2). Not MVP-blocking. Re-open as a separate plan when a workspace requests B2 or e2 residency. |
| STORAGE-LIVE-7 | ❌ Deferred 2026-05-27 — MinIO ad-hoc smoke. Operator-discretionary. STORAGE-12 rollout checklist §3.1 MinIO recipe + `bash scripts/smoke-universal-storage.sh --provider minio` is the canonical procedure. |
| STORAGE-LIVE epic | ✅ Closed + archived 2026-05-27 (`xynes/xynes-infra/docs/plans/archive/2026-05-14-storage-live-provider-rollout.md`) |

## Drizzle Schema Mirror (STORAGE-FU-1)

### Schema ownership

The canonical source of truth for every `platform.storage_*` table is
**`xynes/xynes-infra/supabase/migrations/20260513090000_universal_storage_platform_schema.sql`**.
That migration is owned by `xynes-infra`. `xynes-storage-service` does
**NOT** own the schema and does **NOT** ship Drizzle migrations.

`src/infra/db/schema.ts` is a **read-only mirror** that declares the
canonical columns + closed-set CHECK values so the service can build
type-safe Drizzle queries on top of them.

If you find yourself reaching for `drizzle-kit generate` or
`drizzle-kit push` from this repo, **stop**. Schema changes must land in
the `xynes-infra` Supabase migration first; only then update the mirror
here.

### Closed-set type unions

Every `CHECK status IN (...)` constraint in the canonical migration is
mirrored as a `readonly` tuple constant + `type` union:

| Constant | Type | Source CHECK |
|---|---|---|
| `STORAGE_PROVIDER_KINDS` | `StorageProviderKind` | `workspace_storage_providers_kind_check` |
| `STORAGE_PROVIDER_STATUSES` | `StorageProviderStatus` | `workspace_storage_providers_status_check` |
| `STORAGE_OBJECT_STATUSES` | `StorageObjectStatus` | `storage_objects_status_check` |
| `STORAGE_OBJECT_VISIBILITIES` | `StorageObjectVisibility` | `storage_objects_visibility_check` |
| `UPLOAD_SESSION_METHODS` | `UploadSessionMethod` | `storage_upload_sessions_method_check` |
| `UPLOAD_SESSION_STATUSES` | `UploadSessionStatus` | `storage_upload_sessions_status_check` |
| `STORAGE_VARIANT_STATUSES` | `StorageVariantStatus` | `storage_object_variants_status_check` |
| `PROCESSING_JOB_STATUSES` | `ProcessingJobStatus` | `storage_processing_jobs_status_check` |

The Drizzle text columns are branded via `.$type<...>()` so callers
cannot accidentally write an out-of-set value (e.g. `status: 'archived'`
against a `storage_objects` row fails to compile).

### DB client factory

```ts
import { createStorageDb } from './infra/db';

const { db, close } = createStorageDb(process.env.DATABASE_URL);
// inject `db` into every repository constructor; no module-level singleton.
// composition root (STORAGE-FU-4) owns the lifetime + the `close` call on shutdown.
```

The factory:

- **Throws on startup** if `DATABASE_URL` is missing/blank. Composition
  root must let this bubble up so the service fails fast.
- Collapses to **one connection** when `NODE_ENV=test` so integration
  tests do not deadlock.
- Honours `STORAGE_DRIZZLE_LOG=1` for opt-in query logging. Off by
  default. STORAGE-9 redaction rules run at log-emit time inside
  `infra/logger.ts`; this client never has to know about provider
  credentials.

### Drift detection

```bash
bun run db:check
```

`scripts/db-check.ts` is a **static** drift check (no DB required). It:

1. Reads the canonical migration (override via `STORAGE_INFRA_MIGRATION_PATH`).
2. Asserts every required table exists in the migration.
3. Asserts every closed-set type constant in the mirror matches the
   migration's `CHECK status IN (...)` allowlist.
4. Asserts the migration does **not** introduce any forbidden raw-credential
   column (`provider_credentials`, `raw_key`, `secret_access_key`, `r2_token`,
   `signed_url`, `presigned_url`, `access_key_id`).

Exit 0 means the mirror is in sync. Exit 1 prints every diff and is the
CI gate.

### Security invariants

- **No raw provider credential columns.** `credential_ref` is the only
  column that touches credentials; it stores a reference (secret-manager
  key / env alias). Forbidden column names are blocked at three layers:
  1. The canonical migration itself (rejected at code review).
  2. The schema mirror (asserted by `tests/infra/db/schema.test.ts`).
  3. `bun run db:check` (CI gate against migration drift).
- The mirror declares minimal `platform.workspaces` + `identity.users`
  Drizzle handles for FK type-safety only. We never read or write those
  tables from this service.

### Out of scope

STORAGE-FU-1 ships **only** the schema mirror, DB client factory, and
drift check. It does **not** ship repository implementations — those
land with STORAGE-FU-2 (`PostgresStorageObjectRepository` etc.). The
composition root (`src/index.ts`) is not wired in this story; production
action handlers continue to be unregistered until STORAGE-FU-4 lands.

## Local Smoke + Rollout Checklist (STORAGE-12)

STORAGE-12 ships the rollout gate for Universal Object Storage. It is
**provider-parameterised** — the same harness runs against R2 (default),
Backblaze B2, iDrive e2, AWS S3, or operator-ad-hoc MinIO.

### Docker compose wiring

`xynes-infra/docker-compose.dev.yml` now declares the `storage-service`
container. The gateway depends on it so the stack boots cleanly. The
container reads `PORT` (default `4204`), `DATABASE_URL`,
`INTERNAL_SERVICE_TOKEN`, and `INTERNAL_AUTH_MODE` from the env file
(`.env.dev` by default, `.env.dev.local` for local Supabase mode).
`STORAGE_SERVICE_URL=http://storage-service:4204` is the gateway-side
proxy target.

**MinIO is NOT bundled.** `docker-compose.dev.yml` does not include a
MinIO service; operators who want to exercise the adapter end-to-end
without R2 credentials must spin MinIO up ad-hoc on their host. See the
rollout checklist for the one-time `docker run quay.io/minio/minio`
recipe.

### Smoke harness

| Script | Purpose |
|---|---|
| `xynes-infra/scripts/smoke-universal-storage.sh` | Live smoke battery. Defaults to routing + redaction only; `--full` opts in to the upload→complete→read flow (which requires the follow-up "registerActions" infra story). |
| `xynes-infra/scripts/cleanup-universal-storage.sh` | Aborts stale `pending` upload sessions and soft-deletes smoke-fixture objects via the gateway. Safe `--dry-run` mode. |
| `xynes-infra/scripts/test/smoke-universal-storage.test.sh` | Static validator. Asserts the smoke harness's `--help` output, fail-fast envelope, action-key + redaction coverage, compose wiring, env-file port consistency, and rollout-checklist coverage. Wired into `scripts/test/run.sh`. |

The smoke harness's redaction sweep (Z.1 + Z.2) re-runs the STORAGE-9
contract live: `docker compose logs storage-service --since <smoke-start>`
AND `docker compose logs gateway --since <smoke-start>` must contain
zero matches for `X-Amz-Signature`, `X-Amz-Credential`,
`X-Amz-Security-Token`, `X-Amz-Date`, `X-Amz-Expires`,
`X-Amz-SignedHeaders`, `xynes_live_<hex>`, `AKIA[A-Z0-9]+`, or the
literal Argon2 marker `$argon2` (which prefixes `$argon2id$…`,
`$argon2i$…`, and `$argon2d$…` hashes — the smoke matches it via
`grep -E '\$argon2'` so the leading `$` is a literal dollar, not an
end-of-line anchor). If any pattern appears, **the redaction promise is
broken** — STOP and file a bug.

### Provider-parameterised rollout checklist

`xynes-infra/docs/runbooks/universal-storage-rollout-checklist.md`
documents the full per-provider rollout sequence (onboarding gate, bucket
creation, lifecycle policy, CORS, credential reference, health check,
malware scanner, worker concurrency, redaction verification, SigV4
verification, `x-amz-tagging` absence verification). One block; runnable
against any MVP-ready provider. iDrive e2 carries the only provider-
specific onboarding gate (region MUST be enabled before bucket creation).

### What STORAGE-12 deliberately does NOT include

- **Production wiring of the STORAGE-5/6/7 repository contracts against
  Drizzle.** The smoke harness's `--full` mode will return
  `400 UNKNOWN_ACTION` until that follow-up infra story registers handlers
  in `src/index.ts`. STORAGE-12 ships the gate; the wiring is the next
  story.
- **A canonical MinIO compose service.** Plan §STORAGE-12 deliberately
  scopes MinIO as opt-in ad-hoc. If a future operator needs a permanent
  local-dev MinIO, that's a small follow-up.
- **Real bucket provisioning.** This service runs against
  per-workspace `platform.workspace_storage_providers` rows. Workspaces
  are provisioned per the rollout checklist; STORAGE-12 itself does not
  create any buckets.
- **CMS body validation that rejects nodes carrying provider config.**
  STORAGE-11's `stripTransientImageUrls` is the first line of defense;
  a future CMS Core validator is the second. Not part of STORAGE-12.

## Production Repositories (STORAGE-FU-2)

### What landed

STORAGE-FU-2 ships the Postgres (Drizzle) implementations of every
repository contract introduced by STORAGE-5 / STORAGE-6 / STORAGE-7 /
STORAGE-9. The runtime composition root (STORAGE-FU-4) wires these
implementations into the handler dispatchers; until then `src/index.ts`
still registers nothing and every action key returns `400 UNKNOWN_ACTION`.

### Source layout

```
src/infra/db/repositories/
  ├── index.ts                            # barrel
  ├── mappers.ts                          # row → DTO mappers (shared)
  ├── object-and-session-repository.ts    # storage_objects + storage_upload_sessions
  └── variant-job-usage-repository.ts     # variants + processing jobs + usage daily
```

### Implementations

| Contract | Class | Owner story |
| --- | --- | --- |
| `StorageObjectRepository` | `PostgresStorageObjectRepository` | STORAGE-5 |
| `UploadSessionRepository` | `PostgresUploadSessionRepository` | STORAGE-5 |
| `ExtendedStorageObjectRepository` | `PostgresExtendedStorageObjectRepository` | STORAGE-6 |
| `StorageVariantRepository` | `PostgresStorageVariantRepository` | STORAGE-6 |
| `StorageProcessingJobRepository` | `PostgresStorageProcessingJobRepository` | STORAGE-6 |
| `StorageUsageRepository` | `PostgresStorageUsageRepository` | STORAGE-6 |
| `ProcessingJobQueueRepository` | `PostgresProcessingJobQueueRepository` | STORAGE-7 |
| `StorageObjectStatusRepository` | `PostgresStorageObjectStatusRepository` | STORAGE-7 |
| `AbandonedUploadSessionRepository` | `PostgresAbandonedUploadSessionRepository` | STORAGE-9 |

Production usage (STORAGE-FU-4 will do this):

```ts
import { createStorageDb, PostgresUploadSessionRepository } from './infra/db';

const { db, close } = createStorageDb(process.env.DATABASE_URL);
const sessions = new PostgresUploadSessionRepository(db);
// → pass `sessions` into `registerUploadActionHandlers({ sessions, objects, providers })`.
```

### Invariants enforced (proven by integration tests)

- **Workspace scoping.** Every read / mutate filters on `workspace_id`
  (or scopes via the parent object for variants which have no workspace
  column). No repo method allows a caller to read or mutate rows for
  an unspecified workspace. Cross-workspace probes return `null` /
  empty without leaking row existence.
- **Atomic `createObjectWithSession`.** Both inserts run inside one
  `db.transaction()`. A primary-key collision on the session insert
  rolls back the object insert — verified by an integration test that
  reuses a session id deliberately.
- **Conditional transitions return `null` on race-loss.**
  `markUploaded` / `markCompletedIfPending` / `markAbortedIfPending` /
  `markExpiredIfPending` / `softDeleteForWorkspace` /
  `updateAggregateStatus` all use parameterised `WHERE status = ...`
  conditional updates and either return the updated row or `null`.
- **`SELECT … FOR UPDATE SKIP LOCKED` for `claimNextQueuedJob`.**
  Verified by a `Promise.all` test that issues two concurrent claims
  against two queued rows and asserts the workers claim different ids.
  The implementation runs inside one transaction so the row lock spans
  the SELECT + UPDATE.
- **`releaseClaimedJob` does NOT bump `attempts`.** Per the STORAGE-7
  contract, a per-workspace-cap release is not a completed attempt.
- **Soft-delete excluded from list responses.** STORAGE-6 invariant
  carried into the repo: `listForWorkspace` filters `status <> 'deleted'`
  at the SQL layer; the response builder filters again for defense in
  depth. Soft-deleted rows remain visible to `findByIdForWorkspace`
  (the delete handler's idempotent path needs them).
- **No raw SQL with string interpolation.** Every parameter — including
  the `workspaceAllowlist` for `claimNextQueuedJob` — passes through
  Drizzle's parameterised tagged-template binding via `sql.join`. No
  hand-built `'${id}'::uuid` paths.

### Field-level row → DTO divergence (centralised in `mappers.ts`)

| DB column | DTO field | Why |
| --- | --- | --- |
| `storage_object_variants.variant_kind` | `variantKey` | Storage contract historic naming |
| `storage_object_variants.duration_ms` | (omitted) | Variant DTO does not expose duration today |
| `storage_processing_jobs.job_kind` | `jobType` | STORAGE-7 uses closed `ProcessingJobType` enum |
| `storage_processing_jobs.error_message` | (omitted) | Raw runner output never leaves the DB |
| `storage_processing_jobs.{started_at, finished_at}` | `updatedAt` (derived) | DTO needs one timestamp |
| `storage_usage_daily.operations_class_a` | `classAOperations` | STORAGE-6 DTO naming |
| `storage_usage_daily.operations_class_b` | `classBOperations` | STORAGE-6 DTO naming |
| `bigint` columns (`byte_size`, etc.) | `number` | DTO contract uses `number` |
| (no column) | `StorageProcessingJobRecord.required` | Derived from `jobKind` table; see below |

### The `required` flag (STORAGE-7)

The canonical migration STORAGE-2 does NOT carry a `required boolean`
column on `storage_processing_jobs`. The STORAGE-7 contract requires it,
so the repo derives `required` from a fixed `jobKind` → `boolean` map
that mirrors the planner exactly:

| `jobKind` | `required` |
| --- | --- |
| `scan_validation` | `true` |
| `video_probe` | `true` |
| `image_optimize` | `false` |
| `video_thumbnail` | `false` |
| `video_transcode` | `false` |
| `document_preview` | `false` |
| (unknown) | `true` (fail-closed) |

When a follow-up migration adds the column, delete the lookup table in
`mappers.ts` and read `required` straight off the row.

### Integration test contract

Tests live in `tests/infra/db/repositories/` and run against a real
Postgres instance. The default URL is the dev Supabase stack
(`postgresql://postgres:postgres@127.0.0.1:5432/postgres`); override
with `STORAGE_INTEGRATION_DB_URL` in CI. Tests skip cleanly when the DB
is unreachable so a clean laptop (no Docker, no Supabase) still passes
`bun test`. Each test seeds its own workspace + user + provider
fixture and relies on the `ON DELETE CASCADE` on `workspace_id` to
clean up every storage row tree on teardown.

#### Hard-fail mode for CI (STORAGE-FU-2-FU-3)

Setting `STORAGE_INTEGRATION_DB_REQUIRED=1` in the environment flips
the `connectOrSkip()` helper from soft-skip to hard-fail: when the DB
is unreachable, the helper throws a credential-sanitized error
instead of returning `null`. The CI `integration-db` job sets this
env var so silent skips can no longer hide integration-test breakage
in CI.

Closed-set semantics: only the literal string `'1'` enables hard-fail
mode. `STORAGE_INTEGRATION_DB_REQUIRED=true`, `=yes`, or any truthy
non-`'1'` value preserves the soft-skip posture. This avoids
accidentally enabling hard-fail when an operator copies the env var
from another service that uses different truthy conventions.

Credential redaction: the error message NEVER carries the DB
password. The URL is sanitized via `URL.host` (host:port only) before
embedding it in the message. See `sanitizeUrlForLogging()` in
`tests/infra/db/repositories/_db.ts`.

The CI job is documented in `.github/workflows/ci.yml` under the
`integration-db` job. It pins `supabase/postgres:17.4.1.018` as a
service container, checks out the `xynes-infra` repo into a sibling
directory (via the `XYNES_INFRA_READ_TOKEN` secret — a PAT with
`repo:read` on `Xynes-Studio/xynes-infra`), applies every canonical
migration in timestamp order via `psql`, verifies the four base
tables exist, runs `bun run db:check` to confirm the Drizzle mirror
is in sync, then runs the integration suites with
`STORAGE_INTEGRATION_DB_REQUIRED=1`.

Local-dev posture is preserved: on a clean laptop without the env
var, `connectOrSkip()` still returns `null` and tests soft-skip
cleanly.

### Out of scope (deferred to later STORAGE-FU-N stories)

- **Composition root wiring.** That's STORAGE-FU-4. STORAGE-FU-2 ships
  the implementations; the wiring of `registerUploadActionHandlers` /
  `registerObjectActionHandlers` / `ProcessingWorker.start()` /
  `AbandonedUploadCleanup.start()` lands next.
- **Production runners.** That's STORAGE-FU-5 (sharp / ffmpeg /
  libreoffice / clamav).
- **Adding a `payload jsonb` column on `storage_processing_jobs`.** The
  STORAGE-7 contract allows an empty payload; runners receive the parent
  object via `JobRunnerContext.object`. A future column lands when
  payload-driven runners need persistence.
- **Adding a `required boolean` column on `storage_processing_jobs`.**
  Today the repo derives `required` from `jobKind`. Adding the column
  removes the lookup table.

## Provider Resolver + Secret Manager (STORAGE-FU-3)

STORAGE-FU-3 ships the production resolver against
`platform.workspace_storage_providers` plus a vendor-neutral
`SecretManagerClient` interface for resolving `credential_ref` to raw
provider credentials. The resolver implements BOTH the STORAGE-5
`StorageProviderResolver` (workspace default) and the STORAGE-6
`ExtendedStorageProviderResolver` (default + by-id) contracts so the
STORAGE-FU-4 composition root can construct one instance and pass it to
every handler factory.

### Source layout

- `src/infra/providers/secret-manager.ts` — `SecretManagerClient`
  interface, closed-set `SecretManagerError` codes (`NOT_FOUND`,
  `BACKEND_UNAVAILABLE`, `MATERIAL_INVALID`, `URI_INVALID`),
  `parseSecretRef` (strict `secret://<path>` URI parser),
  `secretPathToEnvPrefix` (pure `secret://storage/r2/dev` →
  `STORAGE_CREDENTIAL_STORAGE__R2__DEV_ACCESS_KEY_ID`
  `STORAGE_CREDENTIAL_STORAGE__R2__DEV_SECRET_ACCESS_KEY` injective mapping — see
  "Secret-manager interface" below), and the local-dev
  `EnvSecretManagerClient`.
- `src/infra/db/repositories/provider-resolver.ts` —
  `PostgresExtendedStorageProviderResolver` and its DI types.

### Provider-kind mapping (DB → adapter)

The DB `provider_kind` CHECK constraint allows three values (`r2`,
`minio`, `s3_compatible`); the adapter knows six (`r2`, `b2`,
`idrive_e2`, `aws_s3`, `s3_generic`, `minio`). The resolver maps:

| DB `provider_kind` | Adapter `ProviderKind` | `forcePathStyle` | Default region |
|---|---|---|---|
| `r2`              | `r2`                  | `false`          | `auto`         |
| `minio`           | `minio`               | `true`           | `us-east-1`    |
| `s3_compatible`   | `s3_generic`          | `true`           | `us-east-1`    |

Adding a new DB `provider_kind` REQUIRES updating: (1) the canonical
Supabase migration's CHECK constraint, (2) the Drizzle schema mirror's
`STORAGE_PROVIDER_KINDS` array, (3) the resolver's three lookup tables,
(4) STORAGE-FU-1's `db:check` drift test.

### Secret-manager interface

`credential_ref` is a vendor-neutral `secret://<path>` URI. The
resolver hands it to a `SecretManagerClient` implementation; the
implementation maps the URI to a secret-manager backend.

Local-dev (`EnvSecretManagerClient`):

```
secret://storage/r2/dev   →  STORAGE_CREDENTIAL_STORAGE__R2__DEV_ACCESS_KEY_ID
                              STORAGE_CREDENTIAL_STORAGE__R2__DEV_SECRET_ACCESS_KEY
secret://storage/r2-dev   →  STORAGE_CREDENTIAL_STORAGE__R2_DEV_ACCESS_KEY_ID
                              STORAGE_CREDENTIAL_STORAGE__R2_DEV_SECRET_ACCESS_KEY
```

The encoding is **injective by construction** so two distinct
`credential_ref` values can never collapse to the same env block (PR-11
Codex P2 review):

- `/` (path segment separator) → `__` (double underscore)
- `-` (within-segment hyphen)  → `_`  (single underscore)
- `_` is NOT a legal path character — `parseSecretRef` rejects it so
  no third producer of `_` exists in the output.

Strict URI rules (defense-in-depth — DB constraints already require
non-blank, but `parseSecretRef` rejects every malformed input BEFORE
the backend is contacted):

- Must start with `secret://`. No `http://`, `https://`, `file://`, `ftp://`.
- Path 1..256 chars, lowercase letters / digits / `-` / `/` only.
- Underscores are rejected (keeps the env-prefix mapping injective).
- No leading `/`, no `..`, no query, no fragment.

Hosted environments wire a different `SecretManagerClient` (AWS Secrets
Manager, Doppler, Vault, GCP Secret Manager) in their composition root.
The resolver does NOT care which backend serves the call — that's
deliberately a per-environment story per the plan's §6.

### Security invariants (proven by tests)

- **Workspace scoping at the SQL layer.** Every SELECT carries
  `workspace_id = $ws` as the first WHERE clause. Cross-workspace
  `resolveByProviderIdForWorkspace` returns `null`, NOT throws (preserves
  the STORAGE-6 "no enumeration oracle" invariant).
- **Disabled rows are invisible.** Rows with `status = 'disabled'` are
  filtered out of both resolve paths.
- **Credential allowlist.** Only `id`, `provider_kind`, `endpoint`,
  `region`, `bucket`, `display_name`, `credential_ref` reach the
  resolver from the row. `credential_ref` is consumed inside the
  resolver and NEVER returned to the caller. Only `providerKind`,
  `endpoint`, `region`, `bucket`, `forcePathStyle`, `accessKeyId`,
  `secretAccessKey` reach the adapter (asserted by `Object.keys` set
  comparison in the unit suite).
- **Error redaction.** Every `SecretManagerError` is wrapped in a
  `ProviderAdapterError` with a generic safe message. The original
  message text NEVER bleeds through (the closed-set
  `SecretManagerErrorCode` is the only signal passed to the wrap layer).
  Custom non-`SecretManagerError` backend errors are wrapped as
  `PROVIDER_OPERATION_FAILED` with a generic message — a hostile
  message containing `AKIA-*` / `xynes_live_*` / `X-Amz-Signature=*` is
  guaranteed not to appear in the final response.
- **NULL endpoint → safe fallback.** `endpoint` is nullable in the DB
  schema but the resolver requires a non-blank value; missing or blank
  endpoint surfaces as `PROVIDER_CONFIG_INVALID` with a generic
  message (no value echo).
- **No global default fallback.** A query for workspace A's provider
  NEVER falls back to a default belonging to workspace B. Each workspace
  must have its own `platform.workspace_storage_providers` row.

### Production wiring example (STORAGE-FU-4 composition root)

```ts
import {
  PostgresExtendedStorageProviderResolver,
  EnvSecretManagerClient,
  createStorageDb,
} from '<storage-service>';

const { db, close } = createStorageDb(process.env.DATABASE_URL!);
const secrets = new EnvSecretManagerClient(); // or AWS Secrets Manager, etc.
const providers = new PostgresExtendedStorageProviderResolver(db, secrets);

// Pass `providers` to BOTH registerUploadActionHandlers AND
// registerObjectActionHandlers — the single class implements both
// interfaces.
```

### Tests

- `tests/infra/providers/secret-manager.test.ts` — 22 unit tests
  covering `parseSecretRef` (every rejection path),
  `secretPathToEnvPrefix`, and `EnvSecretManagerClient`
  (success / `NOT_FOUND` / `MATERIAL_INVALID` / partial-config / blank
  values / `URI_INVALID` / no-leak invariant).
- `tests/infra/db/repositories/provider-resolver.test.ts` — 26 unit
  tests against an in-memory fake `StorageDb` covering: both resolve
  methods (success / null / blank inputs / cross-workspace null),
  every `SecretManagerErrorCode` mapping, unknown backend error
  wrapping, the closed-set provider-kind map (including unknown future
  kind rejection), region default fallback, endpoint NULL/whitespace
  validation, adapter-builder allowlist (`Object.keys` set comparison),
  s3-adapter-deps forwarding, and the no-leak invariant against
  hostile error payloads.
- `tests/infra/db/repositories/provider-resolver.integration.test.ts`
  — 10 integration tests against a real Postgres covering workspace
  scoping (cross-workspace null), `status = 'disabled'` filtering,
  end-to-end resolution with `EnvSecretManagerClient`, and the
  orphan-workspace case. Soft-skips when the DB is unreachable so a
  clean laptop still passes `bun test`.

### Out of scope (deferred to later STORAGE-FU-N stories)

- **Hosted secret-manager implementations.** Each is a separate
  per-environment story; STORAGE-FU-3 ships the interface +
  `EnvSecretManagerClient` for local dev.

## Production Runners (STORAGE-FU-5)

STORAGE-FU-5 closes the gap between STORAGE-FU-4's empty
`runners: {}` posture and a worker that actually consumes jobs. After
this story, `ProcessingWorker` has a runner registered for every
STORAGE-7 `ProcessingJobType` (`scan_validation` /
`image_optimize` / `video_probe` / `video_thumbnail` /
`video_transcode` / `document_preview`) and the upload-complete
handler emits real processing jobs that the worker can pick up.

The production processor adapters (sharp / ffmpeg / libreoffice /
clamav) are deliberately scaffolded as **safe-fail stubs** in this
story — see "Out of scope" below. Real adapter wiring lands as a
follow-up infra story per plan §8.

### Source layout

Everything new lives under
`xynes-storage-service/src/infra/processors/`:

| File | Role |
|---|---|
| `provider-io.ts` | `createS3ProviderObjectIO` — server-side `ProviderObjectIO` impl backed by the resolved `StorageProviderAdapter`'s new `getObjectBytes`/`putObjectBytes` methods. Routes per-call via `workspaceId` + optional `providerId`. |
| `variant-writer.ts` | `PostgresStorageVariantWriter` — Drizzle-backed `StorageVariantWriter` impl with original-protection + workspace scoping. |
| `stub-processors.ts` | `StubImageProcessor` / `StubVideoProcessor` / `StubDocumentProcessor` — pass-through stubs that emit short synthetic byte payloads. Default for `NODE_ENV !== 'production'`. |
| `production-processors.ts` | `ProductionImageProcessorStub` / `ProductionVideoProcessorStub` / `ProductionDocumentProcessorStub` — throw `RunnerInputError('UNSUPPORTED_FORMAT')` until the real sharp / ffmpeg / libreoffice adapters land. Default for `NODE_ENV === 'production'`. |
| `runner-dependencies.ts` | `resolveProcessorMode` / `createRunnerDependencies` — env-driven processor selection + registry assembly. |
| `index.ts` | Public barrel re-exports. |

Two existing modules were extended additively:

- **`src/infra/providers/types.ts`** — `StorageProviderAdapter` gained
  `getObjectBytes(opts)` + `putObjectBytes(opts)` (server-side I/O for
  runners). All existing methods unchanged.
- **`src/infra/providers/s3-adapter.ts`** — implements the new methods
  via `GetObjectCommand` / `PutObjectCommand` against the existing
  `S3Client`. Uses the same `runWithRedactedError` wrapper as every
  other adapter operation.
- **`src/actions/handlers/processing/runners/ports.ts`** —
  `ProviderObjectIO.readObject` / `writeObject` gained optional
  `workspaceId?` + `providerId?` routing hints. Fakes that already
  satisfied the port keep working (extra fields are ignored).

The eight call sites inside the STORAGE-8 runners (`scan-validation.ts`,
`image.ts`, `video.ts`, `document.ts`) were updated to forward
`object.workspaceId` + `object.providerId` on every I/O call.

### Composition wiring

`buildComposition` from STORAGE-FU-4 now:

1. Resolves the processor mode from `STORAGE_PROCESSOR_MODE` env
   (defaults: `stub` outside production, `live` inside production).
2. Constructs `createS3ProviderObjectIO({ providers: providerResolver })`.
3. Constructs `new PostgresStorageVariantWriter({ db: db.db })`.
4. Calls `createRunnerDependencies(...)` to assemble the registry.
5. Passes the registry to `ProcessingWorker`'s `runners` option.
6. Surfaces the resolved mode on the `storage.service.ready` log
   entry under the `processorMode` field so operators can verify
   at startup which mode the worker is wired for.

Test seam: when the caller passes `options.runners` explicitly (as
STORAGE-FU-4 tests do), STORAGE-FU-5 wiring is skipped and the
override is honoured byte-for-byte. The ready event reports
`processorMode: 'override'` in that case.

### Processor mode contract

| Mode | Default for | Image / video / document |
|---|---|---|
| `stub` | `NODE_ENV !== 'production'` | `Stub*Processor` — pass-through byte payloads with fixed dimensions. Runs without sharp / ffmpeg / libreoffice installed. |
| `live` | `NODE_ENV === 'production'` | `Production*ProcessorStub` — throws `RunnerInputError('UNSUPPORTED_FORMAT')`. The runner remaps every processor throw into a retryable `PROCESSOR_FAILED`, which dead-letters after `maxAttempts` (default 3). |

Override via `STORAGE_PROCESSOR_MODE=stub|live`. Unknown values fall
back to the env-default.

The scan runner always works in both modes — it depends only on the
`MalwareScanner` port (defaults to `noopMalwareScanner`), not on a
media processor. So an upload that has no variants planned (e.g. an
audio file, a generic blob) still flips the parent to `ready` even
when `live` is selected without real processor adapters.

### Security invariants

- **Per-call workspace + provider routing.** `ProviderObjectIO.readObject` /
  `writeObject` carry `workspaceId` (required at the production
  factory) and optional `providerId`. A misconfigured runner cannot
  read or write against the wrong workspace's provider.
- **Resolver error redaction.** Resolver throws are wrapped in
  `PROVIDER_IO_ROUTING_FAILED_MESSAGE` so a secret-manager outage
  cannot leak the underlying error. The resolver itself already
  redacts per STORAGE-FU-3; this is defense in depth.
- **`null` resolution surfaces as `PROVIDER_IO_NOT_FOUND_MESSAGE`** —
  generic and free of provider names / hostnames.
- **Original-protection (variant writer).** Every `recordVariant`
  re-checks the parent object's `providerObjectKey` and refuses if
  the variant key matches. Defense in depth on top of
  `deriveVariantObjectKey`'s static check.
- **Workspace-scoped variant inserts.** The parent object must belong
  to the requested workspace; mismatches return a generic "parent
  object not found" error (no cross-workspace existence oracle).
- **Closed-set runner errors only.** Production stubs throw
  `RunnerInputError('UNSUPPORTED_FORMAT')`. The runner translates
  every processor throw into `RunnerExecutionError('PROCESSOR_FAILED',
  { retryable: true })` per STORAGE-8 design. Raw library names
  (`sharp` / `ffmpeg` / `libreoffice`) never appear in error
  messages.
- **No raw provider material in ready event.** The
  `storage.service.ready` log allowlist is `{ ts, level, service,
  message, event, actionKeys, cleanupPollIntervalMs,
  processorMode }`. A regression test injects a hostile env with
  `STORAGE_CREDENTIAL_*` + raw `DATABASE_URL` and asserts none of
  those bytes appear in the serialized entry.

### Production wiring example

```ts
// Composition root (`src/composition.ts`) constructs everything:
const providerIO = createS3ProviderObjectIO({ providers: providerResolver });
const variantWriter = new PostgresStorageVariantWriter({ db: db.db });
const runnerDeps = createRunnerDependencies({
  providerIO,
  variants: variantWriter,
  env,
  // Optional: pass a real `scanner` (e.g. clamav-rest sidecar).
  // Defaults to `noopMalwareScanner` (returns clean).
});
// runnerDeps.registry → pass to ProcessingWorker.runners
// runnerDeps.mode → 'stub' | 'live' | (or 'override' when caller wins)
```

### Tests

- **`tests/infra/processors/provider-io.test.ts`** (15 tests) —
  routing precondition (missing/blank workspaceId), resolver routing
  (by-id vs. default), `null` resolution → not-found, resolver throw
  → generic message, adapter delegation (read + write + ifAbsent),
  no-leak invariant against hostile resolver error payloads.
- **`tests/infra/processors/variant-writer.integration.test.ts`** (6 tests) —
  runs against real Postgres (soft-skips when DB unreachable). Happy
  path with full row shape; `durationSeconds` → `durationMs`
  conversion; null when duration unset; original-protection refusal;
  cross-workspace refusal; duplicate `(object_id, variant_kind)`
  unique-constraint violation.
- **`tests/infra/processors/stub-processors.test.ts`** (7 tests) —
  port contract + deterministic dimensions + clone-on-read invariant
  for image processor.
- **`tests/infra/processors/production-processors.test.ts`** (6 tests) —
  every method throws `RunnerInputError('UNSUPPORTED_FORMAT')`
  (non-retryable when invoked directly); error message is the code
  only, never a library name.
- **`tests/infra/processors/runner-dependencies.test.ts`** (15 tests) —
  `isProcessorMode` closed-set guard, `resolveProcessorMode` env
  resolution paths (5 cases including unknown / blank), registry
  shape + frozen invariant, mode selection, live-mode failure surface
  (retryable PROCESSOR_FAILED for image_optimize against the
  production stub), caller overrides win against env defaults.
- **`tests/providers/s3-adapter.test.ts`** (+11 tests) —
  `getObjectBytes` + `putObjectBytes` with the AWS SDK fake (command
  shape, transformToByteArray + arrayBuffer fallback, null body,
  unsupported body shape, invalid object key validation, no-leak
  invariant for send() failures, `ifAbsent: true` → `IfNoneMatch: *`,
  `Tagging` omission STORAGE-4 invariant).
- **`tests/composition.test.ts`** (+5 STORAGE-FU-5 tests) —
  processor mode wiring (stub default for test env, live for
  production env, env override, `runners` override → mode=override),
  ready entry no-leak invariant against hostile credential env, full
  registry wired (worker is constructible without UNKNOWN_ACTION).

### Out of scope (deferred to STORAGE-FU-6 + follow-up infra)

- **Real sharp / ffmpeg / libreoffice / clamav adapters.** The
  production-processor stubs throw `UNSUPPORTED_FORMAT` until a
  follow-up infra story:
  1. Adds `sharp` (or equivalent) as a runtime dependency.
  2. Wires ffmpeg via `ffmpeg-static` + `fluent-ffmpeg` OR a
     sidecar container.
  3. Wires libreoffice via a headless `soffice` child process OR a
     sidecar.
  4. Wires clamav via `clamav.js` + a clamd socket OR a sidecar.
  5. Updates the storage-service Dockerfile (or sidecar manifests)
     to install the binaries per the deployment posture chosen in
     plan §12 Q3.
- **Worker `start()` + graceful shutdown.** That's STORAGE-FU-6.
  STORAGE-FU-5 wires the runner registry but does NOT call
  `worker.start()` — the polling loop is deliberately deferred.
- **Live integration smoke against R2.** That's the live-rollout
  plan (`xynes/xynes-infra/docs/plans/2026-05-14-storage-live-provider-rollout.md`).


## Sharp-backed Image Processor (STORAGE-FU-5-FU-A)

STORAGE-FU-5-FU-A closes the gap between STORAGE-FU-5's safe-fail
`ProductionImageProcessorStub` (which throws `UNSUPPORTED_FORMAT` on
every call) and a real image processor backed by `sharp` (libvips).
After this story, an `image_optimize` job in live mode produces real
variant bytes (`> 1024` bytes per variant) instead of the 8-byte stub
artefact OR the production-stub `PROCESSOR_FAILED` envelope. Closes
**Bug 1 (image variants)** from the
`2026-05-27-storage-followups-combined.md` plan.

### Source

| File | Role |
|---|---|
| `src/infra/processors/sharp-image-processor.ts` | `SharpImageProcessor` — sharp/libvips-backed `ImageProcessor` implementing STORAGE-8's port. |
| `src/infra/processors/runner-dependencies.ts` | Extended: `buildLiveImageProcessor()` constructs `SharpImageProcessor` in live mode, falls back to the safe-fail stub with a single startup WARN if the loader throws. Honours `STORAGE_FFMPEG_TIMEOUT_MS` env. |
| `package.json` | Adds `sharp@^0.34.5` as a runtime dependency. |

### Security invariants (asserted by tests)

1. **EXIF / GPS metadata stripping is MANDATORY.** Asserted at JPEG,
   WebP, AVIF output formats by re-probing and checking
   `metadata().exif` is `undefined`. The processor relies on sharp's
   default "strip on re-encode" posture — never calls
   `.withMetadata()` (which would opt INTO preservation).
2. **Defense-in-depth dimension cap.** Re-validates probe dimensions
   against `MAX_IMAGE_DIMENSION` (16k pixels) before re-encode.
   `OVER_MAX_DIMENSIONS` is non-retryable.
3. **No filesystem temporary files.** Sharp processes bytes in
   memory only — a crash mid-encode cannot leak partial bytes.
4. **libvips global pixel cache is disabled** via `sharp.cache(false)`
   at module load. Prevents cross-tenant pixel residue across worker
   invocations.
5. **Closed-set runner errors only.** Sharp / libvips error messages
   NEVER reach the caller. Decode-time failure →
   `RunnerInputError('UNSUPPORTED_FORMAT')` (non-retryable);
   encode-time failure →
   `RunnerExecutionError('PROCESSOR_FAILED', retryable: true)`.
6. **No upscaling.** `.resize({ fit: 'inside', withoutEnlargement: true })`
   preserves source dimensions when variant caps are larger.

### Format mapping

| `ImageVariantSpec.format` | Wire `format` | Wire `contentType` |
|---|---|---|
| `avif` | `avif` | `image/avif` |
| `webp` | `webp` | `image/webp` |
| `jpeg` | `jpeg` | `image/jpeg` |
| `original` | `jpeg` | `image/jpeg` |

`original` falls back to broadest-compat JPEG re-encode per STORAGE-8
contract.

### Live-mode fallback posture

`buildLiveImageProcessor()` tries to construct `new SharpImageProcessor()`.
On success, returns it. On failure (corrupted libvips binding,
unsupported platform), logs ONE `WARN` line at startup and returns
`ProductionImageProcessorStub` — image jobs dead-letter with
`PROCESSOR_FAILED` after `maxAttempts`. The worker keeps running;
only the image leg is affected. WARN message carries NO library hint
(STORAGE-9 redaction posture).

### Tests

- **`tests/infra/processors/sharp-image-processor.test.ts`** (NEW,
  26 unit tests, 66 expects) — probe / render / EXIF stripping at
  JPEG/WebP/AVIF / dimension hard cap / error mapping / wire shape /
  libvips cache state / defensive branches.
- **`tests/infra/processors/runner-dependencies.test.ts`** (+1 Bug 1
  regression guard, "live image variants are real bytes") — wires
  the full image runner against an in-memory deterministic-noise
  JPEG, captures variant writes, asserts each variant > 1024 bytes.

### Out of scope (deferred)

- Real-world camera/phone JPEG fixtures (synthetic test bytes
  exercise every code path; STORAGE-FU-5-FU-F adds the
  fixture-based integration suite).
- Animated GIF / WebP (single-frame only in MVP).
- CMYK / wide-gamut output (sRGB only in MVP).
- Live integration smoke against R2 (live-rollout plan).

## ffmpeg-backed Video Processor (STORAGE-FU-5-FU-B)

STORAGE-FU-5-FU-B closes the gap between STORAGE-FU-5's safe-fail
`ProductionVideoProcessorStub` (which throws `UNSUPPORTED_FORMAT` on
every call) and a real video processor backed by `ffmpeg-static`
invoked via `Bun.spawn`. After this story, `video_probe` /
`video_thumbnail` / `video_transcode` jobs in live mode produce real
re-encoded bytes (poster JPEG > 1 KiB, H.264/AAC MP4 > 1 KiB) instead
of the 24-byte `ftypisom` stub artefact OR the production-stub
`PROCESSOR_FAILED` envelope. Closes **Bug 1 (video variants)** from
the `2026-05-27-storage-followups-combined.md` plan.

### Source

| File | Role |
|---|---|
| `src/infra/processors/ffmpeg-video-processor.ts` | `FfmpegVideoProcessor` — `ffmpeg-static`-backed `VideoProcessor` implementing STORAGE-8's port. |
| `src/infra/processors/runner-dependencies.ts` | Extended: `buildLiveVideoProcessor(env)` constructs `FfmpegVideoProcessor` in live mode, falls back to the safe-fail stub with a single startup WARN if the loader throws. Honours `STORAGE_FFMPEG_TIMEOUT_MS` env. |
| `package.json` | Adds `ffmpeg-static@^5.3.0` as a runtime dependency. |

### Env contract

| Variable | Default | Purpose |
|---|---|---|
| `STORAGE_FFMPEG_TIMEOUT_MS` | `300000` (5 min) | Per-invocation hard timeout. ffmpeg processes that exceed this are killed; the runner sees a retryable `PROCESSOR_FAILED`. Must be a positive integer; malformed values fall back to the default. |
| `FFMPEG_BIN` | (unset) | Optional override for the ffmpeg binary path consumed by `ffmpeg-static`'s own loader. Use only when the bundled binary is unavailable. |

### Security invariants (asserted by tests)

1. **Embedded metadata stripping is MANDATORY.** Every poster +
   transcode argv carries `-map_metadata -1`. Asserted at the
   argv-builder level (cheap, deterministic) AND end-to-end against
   a real ffmpeg run by embedding a `comment=STORAGE_FU_5_FU_B_CANARY`
   field in the source MP4 and asserting the canary substring does
   NOT survive into the transcode output bytes.
2. **No filesystem temp files.** ffmpeg reads from `pipe:0` (stdin)
   and writes to `pipe:1` (stdout). The processor never reaches for
   `os.tmpdir()` so a crash mid-encode cannot leak partial bytes.
   Asserted at the argv-builder level by scanning for `/tmp` / `/var`
   / `/private` path references.
3. **ffmpeg arguments are NEVER user-controlled.** Argv is built from
   the closed-set `VideoProfile` + fixed flags. `Bun.spawn` is invoked
   with an array (never via shell), so even if a hostile string slipped
   past the type system into a numeric profile field, the OS would
   interpret it as a single argv token, not a shell metacharacter.
   Asserted by regex sweep for `;` / `|` / `&` / `` ` `` / `$(` / `<`
   / `>` in every argv element.
4. **Defense-in-depth hard cap re-validation.** STORAGE-8 video
   runners ALSO check `MAX_VIDEO_DIMENSION` (4k) +
   `MAX_VIDEO_DURATION_SECONDS` (1 h). The processor re-validates
   inside `probe()` so a future direct caller can't bypass.
   `OVER_MAX_DIMENSIONS` / `OVER_MAX_DURATION` are non-retryable.
5. **Process timeout enforced.** A runaway ffmpeg invocation is killed
   after `STORAGE_FFMPEG_TIMEOUT_MS` (default 5 min) via
   `proc.kill()`. The killed process surfaces as a retryable
   `PROCESSOR_FAILED` — the worker will retry up to `maxAttempts`
   then dead-letter.
6. **Closed-set runner errors only.** ffmpeg stderr text is NEVER
   surfaced. Library / SDK error text NEVER leaks through
   `RunnerInputError.message` / `RunnerExecutionError.message`.
   Decode-time failures map to
   `RunnerInputError('UNSUPPORTED_FORMAT')` (non-retryable);
   render-time failures map to
   `RunnerExecutionError('PROCESSOR_FAILED', retryable: true)`.
7. **Bytes copied on return.** `renderPoster` / `renderTranscode`
   return a fresh `Uint8Array` — callers never observe the
   underlying `ArrayBuffer` that the Bun stdout reader owned.

### Codec posture (MVP closed set)

- **Video codec:** H.264 (`libx264`, preset `medium`). Bitrate driven
  by `VideoProfile.targetBitrateKbps`. `pix_fmt yuv420p` for broadest
  player compatibility.
- **Audio codec:** AAC LC at 128 kbps fixed default.
- **Container:** fragmented MP4 (`-movflags +frag_keyframe+empty_moov`)
  so the muxer can write to a non-seekable `pipe:1` without rewriting
  the `moov` atom. Players + browsers handle fMP4 transparently;
  CDNs cache the bytes byte-for-byte.

AV1 / WebM / HLS / DASH / hardware-accelerated encoding (NVENC /
VideoToolbox) and multi-resolution ladders are deferred per
STORAGE-8 "out of scope".

### stderr parser

ffmpeg's `-i pipe:0 -f null -` invocation prints input metadata to
stderr in a stable, line-oriented format. `parseFfmpegProbe(stderr)`
returns a `ParsedProbe` object with:

| Field | Source |
|---|---|
| `durationSeconds` | `Duration: HH:MM:SS.cc` line |
| `width` / `height` | First `Stream #N:M ... Video: ... WIDTHxHEIGHT` line |
| `container` | First token of `Input #0, <container>, from` |
| `videoCodec` / `audioCodec` | First Video / Audio stream codec name |
| `rotationDegrees` | `displaymatrix: rotation of N` (newer) or `rotate: N` (legacy) |

Every field is optional. Malformed lines are skipped without
throwing. Adversarial input (`\x00\x01\x02`, 100k chars, etc.) is
asserted not to throw. A buffer that yields no video stream surfaces
as `UNSUPPORTED_FORMAT` at `probe()`.

### Live-mode fallback posture

`buildLiveVideoProcessor(env)` tries to construct `new FfmpegVideoProcessor(deps)`.
On success, returns it. On failure (missing ffmpeg-static binary,
unsupported platform/arch tuple, ESM/CJS interop hiccup), logs ONE
`WARN` line at startup and returns `ProductionVideoProcessorStub` —
every `video_*` job dead-letters with `PROCESSOR_FAILED` after
`maxAttempts`. The worker keeps running; only the video leg is
affected. WARN message carries NO library hint (STORAGE-9 redaction
posture).

### Tests

- **`tests/infra/processors/ffmpeg-video-processor.test.ts`** (NEW,
  55 unit + 1 integration test, 247 expects) — parser happy paths
  (HEALTHY_STDERR, ROTATED_STDERR, ROTATED_LEGACY_STDERR,
  OVER_CAP_STDERR, OVER_DURATION_STDERR, NO_VIDEO_STREAM_STDERR) +
  parser malformed inputs / argv builders (probe + poster +
  transcode) / processor probe + renderPoster + renderTranscode
  via injected spawner fakes / spawner contract (timeout, exit code,
  stdin forwarding, argv kind) / `resolveDefaultFfmpegPath` /
  **Bug 1 integration guard against real ffmpeg** (probe + poster +
  transcode against an in-memory MP4 with embedded canary metadata).
- **`tests/infra/processors/runner-dependencies.test.ts`** (+1 Bug 1
  regression guard "live video variants are real bytes" + 6 env-helper
  tests + 2 fallback-posture tests) — wires `video_thumbnail` +
  `video_transcode` runners against an in-memory MP4, captures
  variant writes, asserts each variant > 1024 bytes;
  `resolveFfmpegTimeoutMs` env parser; `buildLiveVideoProcessor`
  single-WARN fallback latch.

### Out of scope (deferred)

- HLS / DASH adaptive streaming output.
- Multi-resolution ladder per profile.
- Hardware-accelerated encoding (NVENC / VideoToolbox).
- Re-probing the transcode output for canonical duration (the
  caller — `video_transcode` runner — does not consult
  `VideoTranscodeRender.durationSeconds`; we report `0` as the
  honest "unknown" signal rather than fabricating a number).
- ffprobe-based JSON probe (we use `ffmpeg -i ... -f null -` stderr
  scraping because `ffmpeg-static` doesn't bundle ffprobe).
- Live integration smoke against R2 (live-rollout plan).

## LibreOffice-backed Document Processor (STORAGE-FU-5-FU-C)

STORAGE-FU-5-FU-C closes the gap between STORAGE-FU-5's safe-fail
`ProductionDocumentProcessorStub` and a real, byte-producing
`DocumentProcessor` for `STORAGE_PROCESSOR_MODE=live`. Before this
story, a `document_preview` job in live mode dead-lettered with
`PROCESSOR_FAILED` after `maxAttempts` retries (production stub) or
produced a 4-byte JPEG SOI+EOI artefact in stub mode. After FU-C,
live deployments produce real PNG/JPEG previews by speaking HTTP to
the **LibreOffice sidecar** committed to in STORAGE-FU-5-FU-E.

This **closes Bug 1 (document preview variants)** from the combined
follow-ups plan — pending the operator-side env flip + the FU-E
follow-up that builds the slim sidecar image carrying the Bun HTTP
shim.

### Topology — sidecar, NOT in-process

Per STORAGE-FU-5-FU-E §3 the LibreOffice processor runs as a
**sidecar** reached over pod-local DNS. We do NOT bundle `soffice`
into the storage-service image because:

1. **Image footprint** — `soffice` + JRE + fonts is ~400 MB.
2. **Restart isolation** — `soffice` crashes don't take down the
   worker; document jobs degrade cleanly via `PROCESSOR_FAILED`.
3. **Blast radius** — historical `soffice` RCEs against malicious
   documents. Macros are disabled globally via `SAL_DISABLE_MACROS=1`
   on the sidecar container, and the sidecar runs least-privilege
   (`cap_drop: [ALL]`, `read_only: true`, `no-new-privileges:true`).
4. **Cold-start cost** — `soffice` startup is ~2 s. A long-lived
   sidecar amortises that.

### Wire contract

```
POST ${LIBREOFFICE_SERVICE_URL}/convert
Content-Type: application/json
{ "sourceContentType": "<allowlisted MIME>", "bytes": "<base64>" }

  ↓

200 OK
Content-Type: image/png | image/jpeg
X-Document-Page-Width:  <integer>
X-Document-Page-Height: <integer>
<raw PNG/JPEG bytes>
```

Status-code semantics enforced by the processor:
- `200` + allowlisted Content-Type → success.
- `200` + unexpected Content-Type / empty body → `PROCESSOR_FAILED` (retryable).
- `400`–`499` → `UNSUPPORTED_FORMAT` (non-retryable; the sidecar rejected THIS document, retrying same bytes against same sidecar won't help).
- `500`–`599` → `PROCESSOR_FAILED` (retryable; transient sidecar fault).
- Network failure / DNS failure / timeout → `PROCESSOR_FAILED`.
- Anything else (`1xx`, `3xx`) → `PROCESSOR_FAILED`.

### Env contract

- **`LIBREOFFICE_SERVICE_URL`** (required for live mode). Default in
  the FU-E Compose overlay is `http://libreoffice-sidecar:8100`.
  **Pod-local DNS only** — must be `http://` or `https://`; any other
  scheme is rejected at construction time. When unset, `live` mode
  silently falls back to `ProductionDocumentProcessorStub` with a
  single startup `WARN` (audit reason: `url-missing`). Every
  `document_preview` job dead-letters cleanly via `PROCESSOR_FAILED`;
  the worker stays up.
- **`STORAGE_SOFFICE_TIMEOUT_MS`** (optional). Default `60_000`
  (60 s). Per-job timeout enforced via `AbortController`. Parser
  rule: integer ≥ 1, otherwise default. Negative / zero / NaN / blank
  / float all fall back to default — a malformed env can NEVER
  produce a 0-ms timeout (instant abort) or a negative cap.

### Security invariants enforced by tests

1. **Allowlist re-check.** The STORAGE-8 `document_preview` runner
   already filters on `SAFE_DOCUMENT_PREVIEW_MIMES`; the processor
   re-checks defense-in-depth and rejects non-safe MIMEs with
   `UNSUPPORTED_FORMAT` BEFORE any HTTP I/O.
2. **Hard byte cap re-check.** Re-validates against
   `MAX_DOCUMENT_BYTES` (100 MiB) BEFORE bytes go over the wire.
3. **Output Content-Type is a closed set.** Sidecar responses
   claiming any non-`image/png` / `image/jpeg` MIME are rejected.
4. **URL validation at construction.** Only `http://` and `https://`
   schemes accepted. `file://`, `ftp://`, `data:`, `javascript:`,
   unparseable strings all throw `LIBREOFFICE_SERVICE_URL_INVALID`
   at startup — fails loud, not silent.
5. **No raw HTTP error text in runner errors.** Sidecar response
   bodies, headers, stack traces NEVER reach the closed-set runner
   error codes. A regression test injects a hostile error containing
   `AKIA-LEAK`, `x-amz-signature=...`, and `xynes_live_...` strings
   and asserts NONE of them survive into `RunnerExecutionError.message`
   — only the closed-set `PROCESSOR_FAILED` code.
6. **Per-request timeout enforced.** A run-away conversion is
   aborted at `STORAGE_SOFFICE_TIMEOUT_MS` via `AbortController`.
   Timed-out conversions surface as retryable `PROCESSOR_FAILED`.
7. **No filesystem temp files in this processor.** Bytes go over the
   wire as base64 inside a JSON body; the sidecar owns its own
   tmpfs-mounted temp dir for the `soffice --convert-to` working
   area and cleans it up per request.
8. **No URL/path interpolation from user input.** The request URL is
   `${LIBREOFFICE_SERVICE_URL}/convert` — a constant built from env
   + a literal path segment via `new URL('/convert', base)`. A
   trailing slash on the base or an embedded path is correctly
   normalised; nothing from `input` reaches the URL.
9. **Output bytes are copied** into a fresh `Uint8Array` on return —
   callers never observe the underlying `ArrayBuffer` that the
   `fetch` response body owned.
10. **Document properties NEVER survive** the conversion. This is
    the SIDECAR's responsibility (`soffice` strips embedded metadata
    by default when converting to a raster format). The processor
    adds defense-in-depth by rejecting sidecar responses with the
    wrong Content-Type — a misbehaved sidecar that tries to return
    the original document bytes as a "preview" is structurally
    blocked.

### Source layout

| File | Purpose |
|---|---|
| `src/infra/processors/libreoffice-document-processor.ts` | `LibreOfficeDocumentProcessor` + `DocumentSidecarClient` DI port + `defaultFetchSidecarClient` + `validateSidecarUrl` + `buildConvertUrl` + `DEFAULT_SOFFICE_TIMEOUT_MS` |
| `src/infra/processors/runner-dependencies.ts` | Adds `buildLiveDocumentProcessor(env, loader?)` with safe-fail to production stub when `LIBREOFFICE_SERVICE_URL` is unset / loader throws / URL is malformed |
| `src/infra/processors/index.ts` | Barrel re-exports the new types and helpers |
| `tests/infra/processors/libreoffice-document-processor.test.ts` | 60 unit tests covering pure helpers, processor behaviour, sidecar status mapping, and `defaultFetchSidecarClient` wire shape |
| `tests/infra/processors/runner-dependencies.test.ts` | Adds 18 FU-C tests: env-helper coverage + fallback posture + Bug 1 regression guard |

### DI seam

The constructor accepts `LibreOfficeDocumentProcessorDeps`:

```ts
interface LibreOfficeDocumentProcessorDeps {
  readonly serviceUrl: string;                // required, validated
  readonly client?: DocumentSidecarClient;    // test override
  readonly timeoutMs?: number;                // default 60_000
}
```

`DocumentSidecarClient` is the seam tests use to inject a
deterministic response without HTTP I/O:

```ts
interface DocumentSidecarClient {
  convert(input: {
    serviceUrl: string;
    sourceContentType: string;
    bytes: Uint8Array;
    timeoutMs: number;
  }): Promise<DocumentSidecarConvertResult>;
}
```

`defaultFetchSidecarClient` is the production implementation that
calls `globalThis.fetch` with the JSON-base64 body shape documented
above.

### Out of scope (deferred to later FU stories)

- Multi-page preview rendering (single first-page only).
- OCR for image-only PDFs.
- Office encryption / password-protected document handling.
- Streaming responses (the shim currently buffers the full PNG before
  responding; payloads stay well under `MAX_DOCUMENT_BYTES`).
- The Bun HTTP shim that actually serves `POST /convert` on the
  sidecar container — STORAGE-FU-5-FU-E flagged it as the LibreOffice
  sidecar implementation gap. The placeholder image
  (`lscr.io/linuxserver/libreoffice:7.6.7`) ships a desktop GUI, NOT
  the `/convert` API. Until a custom slim image with the shim is
  built, an operator who flips `STORAGE_PROCESSOR_MODE=live` with
  the placeholder image up will see `document_preview` jobs
  dead-letter via `PROCESSOR_FAILED` (the safe-fail behaviour
  documented above) — exactly the posture FU-E §3 commits to.
- Fixture-based integration suite against a real `soffice` binary
  (STORAGE-FU-5-FU-F).
- Live integration smoke against R2 (live-rollout plan).

## ClamAV-backed Malware Scanner (STORAGE-FU-5-FU-D)

STORAGE-FU-5-FU-D closes the gap between STORAGE-FU-5's `noopMalwareScanner`
default (always returns `clean`) and a real malware scanner backed by
[ClamAV](https://www.clamav.net/)'s clamd daemon. STORAGE-9 §3.6 mandates
that hosted environments inject a real scanner; scanner outages MUST surface
as `SCANNER_INCONCLUSIVE` and MUST NEVER be silently coerced to `clean`.

### Files

- `src/infra/processors/clamav-scanner.ts` — `ClamavMalwareScanner` class.
  Speaks the clamd `zINSTREAM` protocol over either TCP (`host` + `port`)
  or a unix socket path (`socketPath`, takes precedence). Maintains a
  single pooled persistent connection per scanner instance with
  reconnect-on-close. Exposes a `__forTesting__` seam (`parseClamdResponse`).
- `src/infra/processors/index.ts` — barrel re-exports
  `ClamavMalwareScanner`, `ClamavMalwareScannerOptions`,
  `DEFAULT_CLAMD_HOST`, `DEFAULT_CLAMD_PORT`, `DEFAULT_CLAMD_TIMEOUT_MS`.
- `src/infra/processors/runner-dependencies.ts` — `createRunnerDependencies`
  selects the scanner per mode: `stub` ⇒ `noopMalwareScanner`; `live` ⇒
  `buildLiveMalwareScanner(env, loader)` which constructs
  `ClamavMalwareScanner`. A failed constructor falls back to an
  internal `unknownScanner` (always returns `{ verdict: 'unknown' }`) with
  a single startup WARN; the worker keeps running and FU-A/B/C jobs are
  unaffected. New env helpers: `resolveClamdHost`, `resolveClamdPort`,
  `resolveClamdSocket`, `resolveClamdTimeoutMs`.

### Env contract

| Env | Default | Notes |
|---|---|---|
| `CLAMD_HOST` | `clamav-clamd` | Sidecar hostname per FU-E §4. Trimmed; blank falls back to default. |
| `CLAMD_PORT` | `3310` | Strict positive-integer parse; malformed → default. |
| `CLAMD_SOCKET` | unset | When set, takes precedence over TCP. Pod-local unix socket path. |
| `CLAMD_TIMEOUT_MS` | `10000` | Strict positive-integer parse; malformed → default. |

### Security invariants (proven by tests)

1. **`unknown` is NEVER coerced to `clean`.** clamd responses other than
   `OK` / `… FOUND` map to `{ verdict: 'unknown' }`. The runner contract
   (STORAGE-8 `scan-validation`) flips parents to `failed` on the required
   `scan_validation` job when verdict is `unknown` after retries.
2. **No raw signature names in error envelopes.** `parseClamdResponse`
   extracts the signature into the typed result; the runner forwards
   `{ verdict: 'infected', signature }` as structured fields, never as
   user-visible error message text.
3. **Bytes are streamed via `INSTREAM`** — never written to a temp file.
4. **Clamd-only upstream** — no external scanning APIs reached from this
   processor.
5. **Connection failures don't leak transport details.** The scanner
   catches every error from `getSocket()` / `sendInstream()` /
   `readResponse()` and returns `{ verdict: 'unknown' }`. The underlying
   `clamd socket closed` / `clamd socket error` / `clamd response timeout`
   strings stay inside the scanner.
6. **Pooled-socket reuse is workspace-agnostic.** The scanner owns ONE
   socket per worker; no per-workspace caching of bytes or signatures.

### Test plan

`tests/infra/processors/clamav-scanner.test.ts` (10 tests):
- `parseClamdResponse` happy / infected / unknown / empty.
- `ClamavMalwareScanner.scan` against a deterministic fake socket factory:
  - Clean verdict + payload bytes verified end-to-end through `zINSTREAM`
    framing (4-byte length prefix + 4-byte terminator).
  - Infected verdict with signature extraction.
  - One persistent socket reused across sequential scans.
  - Reconnect on `closeAfterResponse` (one socket per scan when the
    response stream closes).
  - Timeout returns `unknown` without leaking transport text.
  - `socketPath` takes precedence over `host`/`port` in connection options.

`tests/infra/processors/runner-dependencies.test.ts` adds 5 FU-D tests:
- `stub` mode keeps `noopMalwareScanner` (clean verdict).
- `live` mode wires the clamd scanner by default; scanner failures
  (e.g. unreachable clamd) surface as `SCANNER_INCONCLUSIVE` via the
  STORAGE-8 `scan-validation` runner.
- `resolveClamdHost` / `resolveClamdPort` / `resolveClamdSocket` /
  `resolveClamdTimeoutMs` env-helper coverage.
- `buildLiveMalwareScanner` falls back to the internal unknown scanner
  when the loader throws — single WARN, message contains
  `clamd unavailable` but NEVER the underlying ctor error text or any
  credential pattern.

### Quality gates

- `bun run lint` exit 0.
- `bun run typecheck` exit 0.
- `bun run db:check` exit 0 — no schema impact.
- `bun test` → **1441 / 1441 pass / 3799 expects / 78 files**
  (baseline before FU-D: 1424 / 3658 / 77 — delta +17 tests + 1 file).
- `bun run test:coverage` → overall **funcs=96.72% / lines=99.27%**
  (above ADR-001 80% floor). Per-touched file: `clamav-scanner.ts` at
  **85.71% funcs / 94.61% lines** (uncovered: defensive socket-factory
  fallback + the `clearSocket`/`resetSocket` edge where socket is null);
  `runner-dependencies.ts` at
  **100% / 100%**; `index.ts` at
  **100% / 100%**.

### Out of scope (deferred follow-ups)

- STORAGE-FU-5-FU-F (fixture-based integration suite with the EICAR
  antivirus test vector against a live `clamd` binary).
- Multi-engine scanning (YARA, custom rule sets).
- Scanner-result caching by content hash (job-level dedup via DEDUP-1/2
  handles this already).
- Scanner load balancing across multiple clamd instances.
- Live integration smoke against R2 (live-rollout plan).

## Worker Lifecycle (STORAGE-FU-6)

STORAGE-FU-6 closes the gap between STORAGE-FU-4's constructed-but-not-started
`ProcessingWorker` + `AbandonedUploadCleanup` instances and a production-ready
service that polls for queued jobs + abandoned uploads on startup and shuts
down cleanly on SIGTERM/SIGINT.

### Source layout

- `src/infra/lifecycle.ts` — the single owner of worker / cleanup polling
  loop wiring + graceful shutdown.
  - `startLifecycle(composition, options?)` — calls `worker.start(intervalMs)`
    and `cleanup.start(intervalMs)`, registers SIGTERM + SIGINT handlers,
    returns a `LifecycleHandle` with an idempotent `stop()`.
  - `resolveLifecycleConfig(env)` — reads `STORAGE_WORKER_POLL_INTERVAL_MS`,
    `STORAGE_CLEANUP_INTERVAL_MS`, and `STORAGE_SHUTDOWN_TIMEOUT_MS` via the
    strict `parsePositiveIntMs` parser. Defaults: 5000 ms (worker), 60000 ms
    (cleanup), 30000 ms (graceful shutdown). Negative / zero / NaN / blank /
    float / overflow all fall back to defaults.
  - `parsePositiveIntMs(raw, fallback)` — exported pure helper used by the
    config resolver. Mirrored privately in `src/composition.ts` as
    `parsePositiveInt` (returns `undefined` on miss so the spread-into-options
    pattern at the worker constructor stays clean).
  - `LIFECYCLE_SIGNALS = ['SIGTERM', 'SIGINT']` constant.
  - `LifecycleHandle` shape: `{ config: ResolvedLifecycleConfig, stop(): Promise<void> }`.
- `src/composition.ts` — gained `STORAGE_WORKER_MAX_CONCURRENT` and
  `STORAGE_WORKER_MAX_PER_WORKSPACE` env reading. Defaults: 4 (global) and
  2 (per-workspace) — match STORAGE-7's documented defaults.
- `src/index.ts` — invokes `startLifecycle(composition)` AFTER
  `buildComposition()` and BEFORE `buildApp(config)`, so SIGTERM/SIGINT
  handlers are registered before the HTTP server begins accepting traffic.

### Public API

```typescript
import { buildComposition } from "./composition";
import { startLifecycle } from "./infra/lifecycle";

const composition = buildComposition();
const lifecycle = startLifecycle(composition);
const app = buildApp(config);

// Workers are now polling. SIGTERM/SIGINT will gracefully stop them.
// To stop manually (e.g. in tests):
await lifecycle.stop();
```

### Operational env knobs

| Env var | Default | Purpose |
|---|---|---|
| `STORAGE_WORKER_POLL_INTERVAL_MS` | `5000` | `ProcessingWorker` poll interval. |
| `STORAGE_CLEANUP_INTERVAL_MS` | `60000` | `AbandonedUploadCleanup` poll interval. |
| `STORAGE_SHUTDOWN_TIMEOUT_MS` | `30000` | Maximum time `composition.shutdown` may take before a `shutdown_timeout` log entry is emitted and the process exits anyway. |
| `STORAGE_WORKER_MAX_CONCURRENT` | `4` | Global max concurrent processing jobs across all workspaces. |
| `STORAGE_WORKER_MAX_PER_WORKSPACE` | `2` | Max concurrent processing jobs for a single workspace (prevents starvation). |

All five use the same strict positive-int parser: integer ≥ 1, otherwise
the default wins. A malformed env value (`""`, `"abc"`, `"-5"`, `"3.14"`,
`"99999999999999999999"`) silently falls back — the service never boots
with a 0-ms poll loop or a negative concurrency cap.

These env knobs are deliberately NOT surfaced in the `storage.service.ready`
log entry — they're operational tuning, not part of the action-key contract.
The STORAGE-FU-4 ready-event allowlist (`{ ts, level, service, message, event,
actionKeys, cleanupPollIntervalMs, processorMode }`) is preserved byte-for-byte.
The new `storage.lifecycle.started` log entry has its own narrow allowlist:
`{ event, workerPollIntervalMs, cleanupPollIntervalMs, gracefulShutdownTimeoutMs }`.

### Security invariants

- **Single-shot signal handlers via in-flight guard.** A second SIGTERM
  while shutdown is in-flight resolves to the SAME promise as the first
  via the `stopping: Promise<void> | null` field. `composition.shutdown` /
  `worker.stop` / `cleanup.stop` are called exactly once even under signal
  races. Handler listeners are deregistered after shutdown completes so
  the process exits cleanly without a dangling listener.
- **Idempotent `stop()`.** Calling `stop()` twice resolves cleanly the
  second time without re-invoking `worker.stop()` / `cleanup.stop()` /
  `composition.shutdown()`. Defense-in-depth against a SIGTERM + explicit
  `stop()` race.
- **Stop swallows worker errors.** A thrown `composition.worker.stop()`
  or `composition.cleanup.stop()` is logged via the structured logger
  (which routes through STORAGE-9's redaction) and swallowed — the other
  component still stops, and `composition.shutdown` still runs. Mirrors
  STORAGE-7's `ProcessingWorker.runOnce()` error-swallow contract.
- **Shutdown-timeout race.** `composition.shutdown` is raced against
  `STORAGE_SHUTDOWN_TIMEOUT_MS` so a hung Postgres close cannot block a
  deploy indefinitely. On timeout, a `storage.lifecycle.shutdown_timeout`
  log entry is emitted and the process still calls `onShutdownComplete(0)`
  (best-effort exit).
- **No env leakage into the ready log.** Worker concurrency caps + poll
  intervals are NOT in the `storage.service.ready` payload — they're
  operational knobs, not part of the action-key contract. The
  STORAGE-FU-4 hostile-env regex sweep continues to pass byte-for-byte.
- **Positive-int env parser.** Negative / zero / NaN / blank / float /
  overflow all fall back to documented defaults — a malformed env can
  NEVER produce a 0-ms poll loop or a negative timeout.

### Test seams

`startLifecycle` accepts optional injection points for tests:

```typescript
const lifecycle = startLifecycle(composition, {
  env: { STORAGE_WORKER_POLL_INTERVAL_MS: "100" }, // override the env source
  registerSignalHandler: fakeRegister,             // capture signals deterministically
  removeSignalHandler: fakeUnregister,
  onShutdownComplete: () => {},                    // suppress process.exit in tests
  setTimeoutFn: fakeSetTimeout,                    // drive the timeout race deterministically
  clearTimeoutFn: () => {},
});
```

Production callers never need any of these — `startLifecycle(composition)`
with no options is the canonical path.

### Tests

- `tests/infra/lifecycle.test.ts` — **31 tests across 5 describe blocks**,
  all colocated in one new test file:
  - **`parsePositiveIntMs`** (8 tests) — defaults, valid ints, blank /
    NaN / negative / zero / float / overflow fallback, explicit override.
  - **`resolveLifecycleConfig`** (5 tests) — defaults, explicit env
    overrides, mixed valid/invalid, shutdown-timeout override, all three
    keys resolved together.
  - **`startLifecycle — start phase`** (6 tests) — worker.start +
    cleanup.start invoked with the correct intervalMs, default intervals
    when env is unset, SIGTERM + SIGINT registered exactly once each,
    `lifecycle.started` log allowlist, worker.start throwing degrades
    but service boots, cleanup.start throwing degrades but service boots.
  - **`startLifecycle — shutdown phase`** (10 tests) — explicit stop
    calls composition.shutdown; second stop is a no-op; SIGTERM dispatches
    shutdown then exit(0); SIGINT path identical; second signal while
    in-flight collapses to single shutdown; shutdown timeout fires when
    composition.shutdown hangs; composition.shutdown throwing surfaces as
    `shutdown_failed` log entry without leaking the raw error;
    **worker.stop throwing is swallowed and logged as `worker.stop_failed`**;
    **cleanup.stop throwing is swallowed and logged as `cleanup.stop_failed`**;
    registerSignalHandler throwing degrades silently — explicit stop still works.
  - **`buildComposition — worker concurrency env`** (2 tests) —
    `STORAGE_WORKER_MAX_CONCURRENT` / `STORAGE_WORKER_MAX_PER_WORKSPACE`
    forwarded to `ProcessingWorker` constructor without throwing; blank /
    negative values fall through to STORAGE-7 defaults.

### Out of scope (deferred)

- **Hard SIGKILL on graceful-shutdown timeout.** STORAGE-FU-6 enforces a
  30 s timeout via `Promise.race` and emits a `shutdown_timeout` log
  entry; it does NOT call `process.kill(process.pid, 'SIGKILL')`.
  STORAGE-7's `ProcessingWorker.stop()` and `AbandonedUploadCleanup.stop()`
  already await the current `runOnce` to complete. The orchestrator
  (Docker / Kubernetes) is responsible for SIGKILL on its own deadline
  (typically 30 s).
- **Distributed queue product migration** (pg-boss / SQS) — current
  Postgres-polling worker is sufficient per STORAGE-7 §"Out of scope".
- **Live integration smoke against the running storage stack.** That's
  the successor plan (`xynes/xynes-infra/docs/plans/2026-05-14-storage-live-provider-rollout.md`).


## Content-Hash Dedup Schema (DEDUP-1)

DEDUP-1 lands the **DB-layer half** of the storage dedup story. It adds:

1. **`platform.storage_object_references`** — a reference-counting join
   table. Each row marks one `(object_id, owner_kind, owner_id)`
   reference. The DEDUP-2 handler reads this to decide when to
   soft-delete (last reference removed) vs short-circuit
   (`referencesRemaining > 0`).
2. **`storage_objects_workspace_sha256_uidx`** — a workspace-scoped
   PARTIAL UNIQUE INDEX on `platform.storage_objects (workspace_id,
   sha256)` covering active statuses only (`uploaded` / `processing` /
   `ready`). The DEDUP-2 upload-create handler probes this index to
   short-circuit duplicate uploads: same workspace + same `sha256` →
   return the existing `objectId` instead of minting a new provider URL.

DEDUP-1 ships **only** the schema + Drizzle mirror + DB-level tests. The
handler-layer dedup short-circuit + reference-counted delete handler +
storage-client behaviour lands with **DEDUP-2** (`xynes-storage-service` +
`xynes-front-end/xynes-cms-console-web`).

### Canonical migration

- **File:** `xynes/xynes-infra/supabase/migrations/20260528090000_storage_object_references_and_dedup_index.sql`
- **Contract test:** `xynes/xynes-infra/scripts/test/universal-storage-dedup-schema.test.sh` — auto-wired into `scripts/test/run.sh`. **65 assertions / 0 failures** (includes 8 reconciliation-block assertions).
- **Drizzle mirror update:** `src/infra/db/schema.ts` declares `storageObjectReferences` + `STORAGE_OBJECT_REFERENCE_OWNER_KINDS` closed-set.
- **Drift detector:** `bun run db:check` now loads BOTH the STORAGE-2 base migration AND this DEDUP-1 migration via concatenation; the closed-set parity check covers the new `owner_kind` CHECK constraint, and a dedicated invariant assertion locks the workspace-scoped partial unique index in place.

### Pre-index reconciliation (Codex P1 fix)

The migration includes a reconciliation block that runs **BEFORE** the
`CREATE UNIQUE INDEX` statement. Without it, the index creation would
abort on any environment that already accumulated legacy duplicates
(same `(workspace_id, sha256)` with multiple rows in active statuses —
which is exactly Bug 2's signature).

The reconciliation is a `WITH ranked_duplicates AS (...) UPDATE ...`
that soft-deletes every duplicate except the OLDEST per
`(workspace_id, sha256)` group:

- **Winner selection.** Lowest `created_at` first, lowest `id` as
  tiebreaker. Winner's status is preserved.
- **Losers.** Flip to `status='deleted'`, `deleted_at=now()`,
  `failure_code='DEDUP_RECONCILED'`, and a stable English
  `failure_message`. Non-destructive: rows + provider object keys +
  audit columns are preserved for forensic / billing review.
- **DB safety.** UPDATE only. No `DROP` / `ALTER … DROP` / `TRUNCATE` /
  `DELETE FROM`. The soft-delete pattern is the same one STORAGE-2
  already uses; the `storage_objects_deleted_consistency` CHECK is
  satisfied because `deleted_at` is set.
- **Idempotency.** Re-running the migration is a no-op for the
  reconciliation step — the partial unique index already enforces the
  "exactly one active row per `(workspace_id, sha256)`" invariant, so
  there are no remaining duplicates to demote. `UPDATE 0`.
- **Operator audit.** Post-deploy, an operator can identify which rows
  the migration demoted with
  `SELECT count(*) FROM platform.storage_objects WHERE failure_code = 'DEDUP_RECONCILED'`.

The reconciliation invariant is covered by **6 new integration tests**
in `tests/infra/db/repositories/dedup-schema.integration.test.ts`
under the `DEDUP-1 — pre-index reconciliation (Codex P1 fix)` describe
block: winner selection (oldest), tiebreaker (lowest id), idempotency,
NULL-sha256 immunity, cross-workspace immunity, terminal-status
immunity. Tests that need to seed duplicates run inside a Drizzle
transaction with the dev index temporarily dropped + a rollback
sentinel that restores it.

### Security invariants

1. **Workspace scoping at the DB layer.** The partial unique index keys
   on `(workspace_id, sha256)`, NOT on `sha256` alone. Cross-workspace
   dedup is structurally impossible — a hostile workspace cannot probe
   content existence in another workspace via timing or response-size
   differences. The contract test fails the build if anyone adds a
   `CREATE UNIQUE INDEX … (sha256)` (sha256-only) line.
2. **Closed-set `owner_kind`.** Only six values are accepted:
   `cms_entry`, `comment`, `doc_service`, `user_avatar`, `workspace_logo`,
   `platform_generic`. Adding a new value requires (a) a new additive
   migration that `ALTER`s the CHECK constraint, (b) an in-lockstep
   update to `STORAGE_OBJECT_REFERENCE_OWNER_KINDS` in `schema.ts`,
   (c) an update to the `db-check` drift detector, (d) an update to the
   upstream handler that mints references of the new kind.
3. **No FK on `owner_id`.** Different owner kinds target different
   schemas (`cms.content_entries`, `cms.comments`, `docs.documents`,
   `identity.users`). Validation of the owner identity is the upstream
   handler's job — never a DB FK. The contract test fails the build if
   anyone adds a `REFERENCES` clause to `owner_id`.
4. **No provider material on `storage_object_references`.** The row has
   exactly four columns: `object_id`, `owner_kind`, `owner_id`,
   `created_at`. No `provider_object_key`, no signed URLs, no
   credentials. The contract test sweeps the migration for the standard
   forbidden-column list.
5. **Predicate excludes terminal statuses.** The partial unique index
   predicate is `WHERE sha256 IS NOT NULL AND status IN ('uploaded',
   'processing', 'ready')`. Terminal statuses (`pending_upload` /
   `failed` / `deleted`) are excluded so legitimate retries after an
   aborted multipart, after a failure, or after a soft-delete still
   succeed.

### Integration tests

`tests/infra/db/repositories/dedup-schema.integration.test.ts` runs
against the live dev Supabase stack (soft-skips when DB is unreachable —
same posture as STORAGE-FU-2 repository integration tests). **15 tests,
22 expects**:

- Partial unique index rejects duplicate `(workspace_id, sha256)` when
  both rows are `status='ready'` (asserts the unique-violation code
  `23505` + `constraint_name='storage_objects_workspace_sha256_uidx'`).
- Partial index allows duplicate `(workspace_id, sha256)` when one row
  is `pending_upload` or `failed`.
- Soft-deleting a row unblocks a fresh insert.
- Cross-workspace: same `sha256` in two workspaces is allowed.
- Legacy rows with `NULL sha256` do not block fresh inserts.
- `storage_object_references` composite PK rejects duplicate triples
  (code `23505`).
- `ON CONFLICT (object_id, owner_kind, owner_id) DO NOTHING` is
  idempotent across N calls.
- Multiple references per object across different `(owner_kind, owner_id)`
  triples are allowed.
- Unknown `owner_kind` rejected via CHECK constraint (code `23514`).
- `ON DELETE CASCADE` on `object_id` clears reference rows when the
  parent is hard-deleted.
- Workspace cascade transitively clears reference rows.

### DB safety

- **Strictly additive.** No destructive DDL (no table removal, no
  column removal, no constraint removal, no truncation, no `DELETE
  FROM`).
- **`IF NOT EXISTS` everywhere** → reset-safe + replay-safe. Verified
  live: re-applying the migration against a populated DB emits
  `NOTICE: relation already exists, skipping` for every existing object
  and exits cleanly.
- **`sha256` column NOT made `NOT NULL`.** Pre-existing rows uploaded
  without a hash are preserved as-is and excluded from the partial
  index via the predicate.
- **Rollback:** drop the index + table. No app-side rollback required —
  the DEDUP-2 handler change (not yet shipped) is gated on the index's
  presence via try/catch, so absence means dedup is silently disabled
  (fail-open). The worst case is "we miss a dedup hit," not a
  correctness bug.

### Out of scope (deferred to DEDUP-2 + DEDUP-3)

- **DEDUP-2** — handler short-circuit on the upload-create path
  (probe `(workspace_id, sha256)` , return existing `objectId` +
  `dedupHit: true` instead of minting a new provider URL); reference-counted
  soft-delete in the delete handler; CMS Console storage-client behaviour
  (skip the direct-provider PUT on `dedupHit: true`); optional
  `ownerKind` / `ownerId` payload fields.
- **DEDUP-3** (deferred) — server-side `sha256` verification on
  `complete-upload`. The complete handler should hash the bytes the
  provider actually received and verify against the client-claimed
  `sha256`. On mismatch: drop the dedup reference + flip the row to
  `failed`. Tightens DEDUP-1/2's "client-claimed sha256 is trusted"
  gap. Filed in plan §21.
- **Reference-counting analytics dashboard** — visibility into "what
  objects have N references." Out of scope per plan §21.
- **Cross-workspace dedup with explicit sharing semantics** — defer
  until a customer asks. The partial unique index would need to widen
  to a per-organisation key with explicit ACL semantics; out of scope
  per plan §21.
- **Sharing-aware UX in CMS Console** — `dedupHit: true` is
  deliberately silent in the UI. If product asks for a toast ("same
  file already exists"), it's an additive UI follow-up.


## Content-Hash Dedup Handler + Reference-Counted Delete (DEDUP-2)

DEDUP-2 closes the **handler-layer half** of the storage dedup story.
It extends the schema landed by DEDUP-1 with:

- **Upload-create short-circuit** — when `sha256` is supplied AND a row
  with the same `(workspace_id, sha256)` already exists in `uploaded` /
  `processing` / `ready` state, the handler returns the EXISTING object
  id + `{ dedupHit: true, uploadUrl: null, uploadHeaders: {}, parts: [] }`
  WITHOUT minting a provider URL. The provider adapter is NEVER called
  on the dedup path. A `storage_object_references` row is inserted via
  the new `StorageObjectReferenceRepository` so subsequent deletes know
  not to soft-delete the parent until the last reference is dropped.
- **Reference-counted soft-delete** — `delete` action accepts optional
  `ownerKind` + `ownerId` payload pair. When supplied, the handler
  removes that specific reference row and only soft-deletes the parent
  object when `count(references) == 0`. When omitted, preserves the
  pre-DEDUP-2 force-delete behaviour byte-for-byte (soft-delete
  immediately, leave reference rows in place — `ON DELETE CASCADE` from
  the schema cleans them on hard-delete).
- **Closed-set `ownerKind`** — `cms_entry` / `comment` / `doc_service` /
  `user_avatar` / `workspace_logo` / `platform_generic`. Mirrors the
  canonical migration's CHECK constraint byte-for-byte. The closed-set
  union `StorageObjectReferenceOwnerKind` is exported from
  `src/actions/handlers/uploads/types.ts` for handler code and from
  `src/infra/db/schema.ts` for repo code; `bun run db:check` enforces
  parity with the canonical migration.

### Source layout

- `src/actions/handlers/uploads/types.ts` — extended `StorageObjectRepository`
  with `findExistingByWorkspaceSha256`; new `StorageObjectReferenceRepository`
  contract (`addReference`, `removeReference`, `countReferences`); both
  added optionally to `UploadHandlerDependencies` so legacy callers see
  zero behavioural change.
- `src/actions/handlers/uploads/schemas.ts` — `createUploadPayloadSchema`
  gained optional `ownerKind` + `ownerId` fields (paired: both or neither).
- `src/actions/handlers/uploads/responses.ts` — `CreateUploadSessionResponse`
  gained required `dedupHit: boolean` (defaults to `false` for fresh uploads).
- `src/actions/handlers/uploads/create.ts` — probes
  `findExistingByWorkspaceSha256` BEFORE minting any provider URL; on hit,
  calls `addReference` and returns the existing object. On miss, falls
  through to the existing STORAGE-5 flow; `addReference` is called AFTER
  the atomic object+session insert so a reference is always present
  when a caller eventually deletes the parent.
- `src/actions/handlers/objects/types.ts` — `ObjectsHandlerDependencies`
  gained optional `references: StorageObjectReferenceRepository`.
- `src/actions/handlers/objects/schemas.ts` — `deleteObjectPayloadSchema`
  gained optional paired `ownerKind` + `ownerId` fields.
- `src/actions/handlers/objects/responses.ts` — `DeleteObjectResponse`
  gained optional `referencesRemaining?: number` (omitted when the
  object is actually soft-deleted).
- `src/actions/handlers/objects/delete.ts` — when `ownerKind`/`ownerId`
  are supplied, removes that specific reference, counts remaining, and
  only soft-deletes the parent when `count == 0`.
- `src/infra/db/repositories/object-and-session-repository.ts` — added
  `findExistingByWorkspaceSha256` to `PostgresStorageObjectRepository`.
  Filters by workspace + sha256 + `status IN ('uploaded','processing','ready')`
  — matches the DEDUP-1 partial unique index predicate byte-for-byte.
- `src/infra/db/repositories/object-references-repository.ts` (NEW) —
  `PostgresStorageObjectReferenceRepository`. `addReference` uses `ON
  CONFLICT … DO NOTHING` for idempotency; `removeReference` issues the
  DELETE + `SELECT count(*)` in a single transaction.

### Security invariants

- **Workspace scoping at every layer.** `findExistingByWorkspaceSha256`
  filters on `workspace_id` as the first WHERE clause. Cross-workspace
  dedup probes return `null` (NOT a leak of "exists in another workspace").
  Verified by an integration test that seeds the same sha256 in workspace
  A + workspace B and asserts the probe in B returns the B-owned row,
  NEVER the A-owned row.
- **Closed-set `ownerKind` enforced at DB.** Hostile `ownerKind` like
  `'attacker_owned'` is rejected with a 23514 CHECK violation by the
  DEDUP-1 schema CHECK constraint. `addReference` does NOT pre-filter
  the kind; the DB constraint is the canonical guard so a future migration
  that widens the set automatically lifts the limit without code changes.
- **No identity leak in `dedupHit: true`.** The response is identical
  in shape to a fresh upload response; only the `dedupHit` flag
  distinguishes the two. `createdBy` flows through as a documented
  STORAGE-6 field (not new identity exposure).
- **No provider material in the reference table.** The
  `storage_object_references` row carries `object_id` + `owner_kind` +
  `owner_id` + `created_at` — nothing else. Regression-guarded by the
  STORAGE-4 / DEDUP-1 forbidden-column contract tests.
- **Client-claimed sha256 is NEVER trusted for security decisions.**
  Dedup is a storage-cost optimisation, not an access-control
  mechanism. A malicious sha256 claim within a workspace gets the
  caller a reference to bytes they already have access to within their
  workspace boundary. Cross-workspace dedup is structurally impossible
  because the partial unique index keys on `(workspace_id, sha256)`,
  not on `(sha256)` alone. DEDUP-3 (server-side verification on
  complete-upload) tightens this further — out of scope for DEDUP-2 per
  plan §21.
- **Reference-counted soft-delete never under-counts.** The
  `addReference` call in the handler runs AFTER the atomic
  object+session insert so a reference row is always present when a
  caller eventually deletes the parent. Even on the dedup-hit path the
  reference is minted (otherwise the parent would be deletable by the
  legacy force-delete path that doesn't decrement references).

### Backward compatibility

- Pre-DEDUP-2 callers that don't send `sha256` see zero behavioural
  change — `findExistingByWorkspaceSha256` is only called when sha256
  is present in the payload.
- Pre-DEDUP-2 callers that don't send `ownerKind`/`ownerId` get the
  default `platform_generic` owner kind + a freshly-generated UUID for
  `owner_id`. Their references accumulate but never block their own
  re-uploads (their re-upload hits dedup and adds another reference
  under the same owner kind).
- The new `dedupHit` response field is required on the wire (no
  `?:` optionality at the schema level) so consumers can branch
  confidently. CMS Console storage-client clients parse `dedupHit ===
  true` strictly (any other value collapses to `false`) for backwards
  compatibility with old storage-service builds.
- The new `referencesRemaining` response field on delete is OMITTED
  when the object is actually soft-deleted — existing client code that
  only checks `object.status === 'deleted'` is unaffected.
- `UploadHandlerDependencies.references` and
  `ObjectsHandlerDependencies.references` are BOTH optional. When
  omitted, the handlers fall through to the legacy non-dedup path
  byte-for-byte (uploads always mint a fresh session; deletes always
  soft-delete immediately). This preserves the STORAGE-5 / STORAGE-6
  test posture where existing tests pre-DEDUP-2 don't have to be
  rewritten to inject a references-repository fake.

### Tests

- `tests/actions/handlers/uploads/create-dedup.test.ts` — 21 unit tests:
  dedup hit on `ready` / `processing` / `uploaded` rows; no hit on
  `pending_upload` / `failed` / `deleted` / missing sha256; cross-workspace
  isolation; owner_kind default vs explicit; ownerId default vs explicit;
  `dedupHit: true` response shape (no provider config leak); `addReference`
  idempotency; api_key actor parity; createdBy is the EXISTING uploader.
- `tests/actions/handlers/uploads/references-fake.test.ts` — 12 tests on
  the in-memory `FakeReferencesRepository` covering addReference idempotency,
  removeReference returning correct remaining counts, countReferences,
  composite-PK semantics.
- `tests/actions/handlers/objects/delete-references.test.ts` — 13 unit tests:
  reference-counted delete (last reference removed soft-deletes; remaining
  references leave `status='ready'`); legacy force-delete mode (no
  ownerKind/ownerId provided) preserves byte-for-byte; schema
  validation (paired ownerKind/ownerId).
- `tests/infra/db/repositories/object-references-repository.integration.test.ts`
  — 16 integration tests against live Postgres: addReference happy path
  + idempotency + cross-workspace defense + FK CASCADE; removeReference
  remaining count accuracy; countReferences; closed-set ownerKind
  rejected at DB; CASCADE on object hard-delete clears references.
- `tests/infra/db/repositories/object-and-session-repository.test.ts` (+9 cases)
  — integration tests for the new `findExistingByWorkspaceSha256` method:
  hit on every active status; miss on `pending_upload` / `failed` /
  `deleted`; miss on cross-workspace; miss on null sha256.

### Quality gates (2026-05-28)

- `bun run lint` exit 0.
- `bun run typecheck` exit 0.
- `bun run db:check` exit 0 (Drizzle mirror in sync with both canonical
  migrations).
- `bun test` → **1167 / 1167 pass / 2934 expects / 66 files** (baseline
  before DEDUP-2: 1100 / 2790 / 62 — delta +67 tests + 4 files).
- `bun run test:coverage` → overall **funcs=97.23% / lines=99.52%**
  (above ADR-001 80% floor). Per touched file:
  * `src/actions/handlers/uploads/create.ts`: **87.50% funcs / 100% lines**.
  * `src/actions/handlers/objects/delete.ts`: **100% funcs / 98.51% lines**.
  * `src/infra/db/repositories/object-references-repository.ts`: **100% / 100%**.
  * `src/infra/db/repositories/object-and-session-repository.ts`: 93.94% / 95.40%.

### CMS Console wiring

The FE half of DEDUP-2 lands on `xynes-front-end/xynes-cms-console-web`
branch `feature/DEDUP-2-storage-client-dedup-hit`:

- `storage-client.ts`:
  - `CreateUploadSessionResult` gains `dedupHit: boolean`.
  - `CreateUploadSessionFileInput` gains optional `ownerKind` / `ownerId`.
  - `directProviderUpload` no-ops when `session.dedupHit === true`.
  - Strict-boolean parse — anything other than `true` collapses to `false`.
- `use-storage-upload-adapter.ts`: on `dedupHit: true`, skip BOTH
  `directProviderUpload` and `completeStorageUploadSession`; mint the
  display URL against `session.object.id`.
- Tests: +22 new tests (storage-client 18 + adapter 4); 588 / 588 pass.


## Deployment Posture (STORAGE-FU-5-FU-E)

STORAGE-FU-5-FU-E is the architectural decision record for **how each
live processor (sharp / ffmpeg / LibreOffice / clamav) is deployed**.
It does not change runtime code — the per-processor implementation
stories (FU-A..D) consume the decision via the env contract. The
canonical document is [`docs/deployment-posture.md`](docs/deployment-posture.md);
the summary below is a navigation index.

### Decision summary

| Processor   | Posture                  | Rationale                                                       |
|-------------|--------------------------|-----------------------------------------------------------------|
| sharp       | In-process (Dockerfile)  | ~30 MB libvips binding; in-memory I/O; tight library coupling.  |
| ffmpeg      | In-process (Dockerfile)  | ~80 MB static binary; piped stdin/stdout; no daemon.            |
| LibreOffice | Sidecar container        | ~400 MB (soffice + JRE + fonts); independent restart cadence.   |
| clamav      | Sidecar container (×2)   | ~250 MB defs + freshclam updater isolation; least-privilege.    |

Tier-1 (sharp + ffmpeg) keeps the runtime hot path small and fast.
Tier-2 (LibreOffice + clamav) pushes fat dependencies with independent
lifecycles into sidecars reached over the pod-local network only.

### Env contract (consumed by FU-A..D)

| Env var | Default | Tier | Notes |
|---|---|---|---|
| `STORAGE_PROCESSOR_MODE` | `stub` (non-prod) / `live` (prod) | — | Master switch. |
| `STORAGE_FFMPEG_TIMEOUT_MS` | `300000` (5 min) | Tier-1 | Per-job timeout (FU-B). |
| `STORAGE_SOFFICE_TIMEOUT_MS` | `60000` (60 s) | Tier-2 | Per-job timeout (FU-C). |
| `LIBREOFFICE_SERVICE_URL` | `http://libreoffice-sidecar:8100` | Tier-2 | Pod-local DNS only. |
| `CLAMD_HOST` | `clamav-clamd` | Tier-2 | Pod-local DNS only. |
| `CLAMD_PORT` | `3310` | Tier-2 | TCP port. |
| `CLAMD_SOCKET` | _(unset)_ | Tier-2 | Unix socket; takes precedence over TCP when set. |

Tier-2 processors fall back to the safe-fail production stub when the
env var is unset — a misconfigured live deployment dead-letters cleanly
without crashing the worker.

### Artefacts shipped by FU-E

| File | Owner repo | Role |
|---|---|---|
| `docs/deployment-posture.md` | `xynes-storage-service` | Canonical decision record (§1–§11). |
| `infra/compose/storage-live-processors.yml` | `xynes-infra` | Opt-in Compose overlay adding 3 sidecars + extending storage-service env. |
| `infra/release/deployment-posture/k8s/` | `xynes-infra` | 8-file K3s draft (Namespace, Deployments, Services, PVC, NetworkPolicy). Documentation-grade — not deployed by MVP CI. |
| `scripts/test/storage-fu-5-fu-e-deployment-posture.test.sh` | `xynes-infra` | Static validator wired into `scripts/test/run.sh`. |

### Operator rollout sequence (after FU-A + FU-E both land)

```bash
# 1. Flip processor mode (in the git-ignored .env.dev.local).
# 2. Restart with the live-processors overlay:
cd xynes/xynes-infra
docker compose --env-file .env.dev.local \
  -f docker-compose.dev.yml \
  -f infra/compose/storage-live-processors.yml \
  up -d storage-service libreoffice-sidecar clamav-clamd clamav-freshclam

# 3. Verify sidecars reachable from storage-service:
docker compose exec storage-service sh -c 'echo "PING" | nc clamav-clamd 3310'   # → PONG
docker compose exec storage-service sh -c 'nc -z libreoffice-sidecar 8100 && echo OK'   # → OK (TCP only; FU-C ships /health)

# 4. Re-run the smoke harness:
bash scripts/smoke-universal-storage.sh --full --provider r2
```

The operator step is NOT automated by FU-E — FU-E ships the decision +
manifests + runbook entry. The flip is a manual rollout gate that depends
on FU-A (and FU-B/C/D for video / document / scanner respectively).

### Out of scope

- Helm chart authoring (defer to ops).
- Multi-region deployment topology.
- Auto-scaling policies.
- Production secret-management for sidecar env vars (covered by
  STORAGE-FU-3 hosted-secret-manager follow-ups).
- Per-replica horizontal-pod-autoscaling.
- Sidecar binary installation in CI (FU-F handles CI bring-up).

---

## LibreOffice Sidecar Bun HTTP Shim (STORAGE-FU-5-FU-G)

The slim sidecar image that pairs with FU-C's `LibreOfficeDocumentProcessor`
to close Bug 1 (document) in production. FU-C is the HTTP client; FU-G is
the HTTP server. Bug 1 (document) is NOT closed until BOTH land + the live
R2 smoke from plan §12.5 asserts `byte_size > 1024` for a representative
PDF input.

### Why it lives in this repo (not `xynes-infra`)

Repo policy: `xynes/xynes-infra` is a docs / migrations / scripts repo
(no runnable code). The sidecar's Bun HTTP shim + Dockerfile + tests are
runnable code, so they live here next to their only consumer (FU-C).
`xynes-infra` keeps Compose overlay + K8s draft updates + the static
validator that pins the image tag.

### Source layout

```
xynes-storage-service/sidecars/libreoffice/
├── Dockerfile                 # multi-stage: oven/bun:1.1-debian source → debian:12-slim runtime
├── package.json               # own Bun project; deps decoupled from service runtime
├── tsconfig.json              # strict; isolated from service tsconfig
├── .eslintrc.cjs              # minimal TS rules
├── src/
│   ├── shim.ts                # Bun.serve entry + boot() factory + defaultFs adapter
│   ├── convert.ts             # pure runConvert(input, deps) — DI fs + soffice ports
│   ├── soffice-runner.ts      # createSofficeRunner(spawn, opts) factory + defaultSofficeRunner
│   ├── health.ts              # createHealthChecker — TTL cache + injectable clock
│   ├── parse-request.ts       # strict JSON + base64 parser
│   ├── safe-mime.ts           # closed-set MIME allowlist (mirrors FU-C byte-for-byte)
│   └── errors.ts              # closed-set ShimErrorCode + status + redaction-safe messages
└── tests/                     # 111 tests / 9 files / 319 expects; coverage 94.90/97.48
```

### Wire contract

```
POST /convert
  Body:  application/json — { sourceContentType: string, bytes: <base64> }
  200:   Content-Type: image/png + raw PNG bytes
         Optional: X-Document-Page-Width / X-Document-Page-Height (positive ints)
  400:   INVALID_JSON | MISSING_FIELD | INVALID_BASE64
  413:   OVER_MAX_BYTES               (FU-C maps to OVER_MAX_BYTES)
  415:   UNSUPPORTED_FORMAT           (FU-C maps to UNSUPPORTED_FORMAT, non-retryable)
  500:   CONVERT_FAILED               (FU-C maps to PROCESSOR_FAILED, retryable)
  504:   TIMEOUT                      (FU-C maps to PROCESSOR_FAILED, retryable)

GET /health
  200 { "status": "ok" }       one-shot RTF probe succeeded (cached TTL=15s)
  503 { "status": "degraded" } probe failed or recent CONVERT_FAILED / TIMEOUT
```

The wire shape exactly matches FU-C's `DocumentSidecarClient` expectations
in `src/infra/processors/libreoffice-document-processor.ts`. The shim's
safe-MIME allowlist mirrors FU-C's `SAFE_DOCUMENT_PREVIEW_MIMES` from
`profiles.ts`. Adding a new MIME requires updating BOTH lists; the
xynes-infra static validator at
`scripts/test/storage-fu-5-fu-g-libreoffice-sidecar-shim.test.sh`
regression-guards the cross-list parity.

### Security invariants enforced in code + proven by tests

1. **Non-root user, no shell login.** Container runs as `uid=10001`
   with `/usr/sbin/nologin`. Read-only root FS at runtime; only `/tmp`
   (tmpfs in production) is writable.
2. **`SAL_DISABLE_MACROS=1`** baked into the image-level env AND set
   per-process by `buildSofficeEnv()` (defense in depth on top of FU-E
   orchestrator-level env).
3. **`soffice` argv is fully closed-set.** `buildSofficeArgv` builds
   from the safe-MIME table + per-request UUID-named paths only. No
   user input reaches the argv. Asserted by regex sweep against
   `; | & \` < > $(` shell metacharacters.
4. **Spawn-per-request.** No `soffice --accept` daemon mode (long
   history of memory leaks under sustained load per plan §12.5 risk
   register). Per-request `/tmp/soffice-work-<uuid>` directory wiped
   in `finally`.
5. **SIGTERM-then-SIGKILL kill chain on timeout.** A runaway `soffice`
   process is killed via `proc.kill()` (SIGTERM), then SIGKILL after
   `killGraceMs` (default 2s). Timed-out conversion surfaces as
   `TIMEOUT` (504); `kill()` throwing is swallowed.
6. **Output Content-Type is hard-coded `image/png`.** The shim refuses
   to advertise any other type. Defense in depth: bytes that pass the
   PNG magic-header check but parse as non-image (12-byte truncated
   header) return null dimensions instead of garbage. Successful exit
   code with non-PNG bytes (e.g. fake JPEG header in the output) is
   classified `CONVERT_FAILED`.
7. **Closed-set error codes.** Every non-2xx response is
   `{ code: ShimErrorCode, message: <fixed string> }`. No interpolated
   stderr blobs, no path leakage, no library version strings.
   Regression-guarded by the xynes-infra static validator + per-route
   `JSON.stringify(body).not.toContain('soffice'|'/tmp'|'AKIA'|'xynes_live_'|'X-Amz-Signature')` assertions.
8. **Bun.serve error handler returns redacted 500.** A thrown handler
   error surfaces as `{ code: 'INTERNAL_ERROR', message: 'Internal sidecar error.' }`.
   The raw `Error.message` NEVER reflects.
9. **Debug logs are off by default.** Setting `STORAGE_SIDECAR_DEBUG=1`
   enables a single redacted log line per request (status code +
   content-type only; NEVER request bytes).
10. **`tini` as PID-1.** Mitigates `soffice` zombie accumulation under
    the spawn-per-request model.

### Env contract

| Env var | Default | Purpose |
|---|---|---|
| `STORAGE_SIDECAR_PORT` | `8100` | TCP listen port |
| `STORAGE_SIDECAR_HOSTNAME` | `0.0.0.0` | Bind hostname |
| `STORAGE_SIDECAR_TMP_ROOT` | `/tmp` | Root for per-request workdirs |
| `STORAGE_SIDECAR_TIMEOUT_MS` | `55000` | Per-request soffice timeout (5s under FU-C's 60s default so the shim surfaces TIMEOUT before FU-C's AbortController fires) |
| `STORAGE_SIDECAR_DEBUG` | unset | Set to `1` to enable redacted per-request log lines |

All defaults are safe — malformed env values fall back rather than
crash. Asserted by `tests/config.test.ts`.

### How to run / test locally

```bash
# Run unit tests (no soffice binary required — uses DI fakes).
cd xynes-storage-service/sidecars/libreoffice
bun test
bun test --coverage   # overall 94.90% funcs / 97.48% lines
bun x tsc --noEmit    # zero errors
bun run lint          # eslint clean

# Build the image (requires Docker).
docker build -t xynes/libreoffice-sidecar:0.1.0 .

# Smoke against a live container.
docker run --rm -p 8100:8100 xynes/libreoffice-sidecar:0.1.0 &
curl -sf http://localhost:8100/health
# → { "status": "ok" }
```

### Test summary

- **111 tests / 0 fail / 319 expects / 9 files**.
- Per-file coverage (all ≥ 80% per ADR-001 floor):
  - `convert.ts`, `errors.ts`, `safe-mime.ts`: **100% funcs / 100% lines**
  - `health.ts`: 91.67% funcs / 98.11% lines
  - `parse-request.ts`: 100% funcs / 97.87% lines
  - `shim.ts`: 80% funcs / 91.36% lines (uncovered: defaultServe `if (!bun) throw` branch — exercised only when Bun.serve is unavailable, which is unreachable in a Bun runtime)
  - `soffice-runner.ts`: 87.5% funcs / 92.5% lines (uncovered: `defaultSofficeRunner` factory's `if (!globalBun) throw` branch — same posture)

### Production closure status (Bug 1 — document)

**Code-side complete.** Production closure of Bug 1 (document) requires:

1. Operator builds the image: `docker build -t xynes/libreoffice-sidecar:0.1.0 sidecars/libreoffice/`
2. Operator flips `STORAGE_PROCESSOR_MODE=live` + `LIBREOFFICE_SERVICE_URL=http://libreoffice-sidecar:8100`
3. Operator runs `bash xynes-infra/scripts/smoke-universal-storage.sh --full --provider r2` and asserts `byte_size > 1024` for a representative PDF input.

With FU-A + FU-B + FU-C + FU-E + FU-G all landed (code-side), the only
remaining gate for Bug 1 global closure is the operator-side rollout
sequence.

### Out of scope (deferred follow-ups)

- Multi-page preview rendering.
- OCR for image-only PDFs.
- Office encryption / password-protected document handling.
- Streaming responses (the shim currently buffers the full PNG before
  responding; payloads stay well under `MAX_DOCUMENT_BYTES`).
- Multi-arch image build (linux/arm64 for Apple Silicon dev).
- `soffice --accept` socket pre-warming (current implementation spawns
  fresh per request per plan §12.5 leak-mitigation contract; if
  cold-start latency becomes a bottleneck under sustained load, a
  follow-up could add a long-lived `soffice` instance behind the
  spawn-per-request fallback).
- Pre-warming one idle `soffice` process at boot to absorb cold-start
  latency under the first `/convert` (currently the `/health` probe
  serves that purpose by running an RTF conversion at startup).

## Persisted Payload + Required Columns (STORAGE-FU-2-FU-2)

### What landed

The `platform.storage_processing_jobs` table gained two real columns
that the TS layer previously had to derive:

- **`payload jsonb NOT NULL DEFAULT '{}'::jsonb`** — the planner-emitted
  payload (`{ contentType, byteSize? }`) is now persisted instead of
  silently discarded. `claimNextQueuedJob` reads it straight off the
  row into `ClaimedJob.payload`, where STORAGE-8 runners consume it
  via `JobRunnerContext`.
- **`required boolean NOT NULL DEFAULT true`** — the
  `required`/best-effort discriminator the STORAGE-7 aggregator uses
  to decide whether a terminal failure flips the parent object to
  `failed`. Reading from the row makes the DB the canonical source of
  truth; the previous TS-side `REQUIRED_BY_JOB_TYPE` lookup table was
  removed in the same change.

### Canonical migration

`xynes-infra/supabase/migrations/20260529090000_storage_processing_jobs_payload_and_required.sql`

- Additive only (`ADD COLUMN IF NOT EXISTS`).
- **Fail-closed defaults.** `payload` defaults to `'{}'::jsonb`;
  `required` defaults to `true`. New / unknown job kinds are treated
  as required so they cannot silently dead-letter.
- **Idempotent backfill.** A `UPDATE … SET required = false`
  statement flips the 4 known non-required kinds (`image_optimize`,
  `video_thumbnail`, `video_transcode`, `document_preview`) and is
  guarded by `required IS DISTINCT FROM false` so replay touches
  zero rows.
- Documentation `COMMENT`s on both columns calling out the security
  contract (no credentials, Zod strict validators) and the
  fail-closed semantic.

### Per-jobType payload validators

`src/actions/handlers/processing/payload-schemas.ts` exports
`validateJobPayload(jobType, payload)` plus a closed-set
`JOB_PAYLOAD_SCHEMAS` map covering every `ProcessingJobType`. Each
schema is a Zod `.strict()` object that rejects unknown keys:

- `scan_validation` → `{ contentType, byteSize }`
- `image_optimize`, `video_probe`, `video_thumbnail`,
  `video_transcode`, `document_preview` → `{ contentType }`

`PostgresProcessingJobQueueRepository.enqueueBatch` calls
`validateJobPayload` for every input BEFORE opening a transaction.
Rejections throw `PayloadValidationError` with a closed-set
`INVALID_JOB_PAYLOAD` code + 400 status hint. The error message
surfaces ONLY the rejected key names (collected from the Zod
`unrecognized_keys` / `path` issue shapes); hostile values NEVER
appear in the message (regression-guarded by a dedicated test that
injects `AKIA*` / `xynes_live_*` / `X-Amz-Signature=` substrings).

### Drizzle mirror + drift check

`src/infra/db/schema.ts` declares both columns on
`storageProcessingJobs` with branded types
(`jsonb(...).$type<Record<string, unknown>>()` for payload,
`boolean(...)` for required). `scripts/db-check.ts` extends
`DEFAULT_EXTRA_MIGRATION_PATHS` with the FU-2-FU-2 migration and
adds fail-loud assertions for both columns + the canonical
`NOT NULL DEFAULT` shapes.

### Backward compatibility

- Pre-FU-2-FU-2 callers that never set `payload`/`required` get the
  canonical fail-closed defaults via the column DEFAULT clauses.
- The 4 non-required job kinds are backfilled to match the previous
  `deriveJobRequired` output exactly.
- Old replicas during a rolling deploy never reference the new
  columns and continue to function — the migration is additive so the
  pre-FU-2-FU-2 schema is a strict subset of the post-FU-2-FU-2
  schema.

### Quality gates

- `bun run lint` exit 0; `bun run typecheck` exit 0; `bun run db:check` exit 0.
- `bun test` → **1488 / 1488 pass / 3935 expects / 83 files** (was
  1443 baseline on `develop`; delta exactly +45 from FU-2-FU-2 +
  FU-5-FU-F combined: 24 new payload-schemas tests + ~7 new
  mapper/repo tests + ~14 new fixture-based integration tests).
- `bun run test:coverage` overall **funcs=96.77% / lines=99.29%**
  (above ADR-001 80% floor). Per-touched file: `payload-schemas.ts` **100% / 100%**,
  `variant-job-usage-repository.ts` **100% / 100%**,
  `mappers.ts` **100% / 100%**.

## Fixture-based Integration Suite (STORAGE-FU-5-FU-F)

### What landed

A new `tests/integration/processors/` directory holds per-processor
integration suites that exercise the live runners (sharp, ffmpeg,
LibreOffice, clamav) against committed binary fixtures.

### Fixtures

Five fixtures under `tests/integration/processors/fixtures/`:

| File | Generator | Notes |
|---|---|---|
| `sample.jpg` | sharp + hand-spliced APP1 EXIF | 256×192 deterministic-noise JPEG carrying the standard `0x8825` GPS sub-IFD pointer |
| `sample.png` | sharp | 256×192 deterministic-noise PNG (control fixture) |
| `sample.mp4` | ffmpeg `testsrc` + `sine` | 2-second H.264/AAC at 160×120 with embedded `comment=STORAGE_FU_5_FU_F_FIXTURE_CANARY` |
| `sample.pdf` | hand-rolled minimal PDF | 3 pages + `/Title` + `/Author` + `/Creator` document Info dictionary |
| `eicar.txt` | static string | Standard EICAR antivirus test vector (NOT real malware) |

The deterministic-noise generator (`xorshift32`) is shared with the
FU-A unit-suite Bug 1 regression guard so fixture + unit test stay
aligned on what compresses to a realistic byte size.

A `_generate.ts` script regenerates the corpus idempotently:

```bash
bun run tests/integration/processors/fixtures/_generate.ts
```

The script is documentation-grade — the integration suite reads the
committed binaries only.

### Suite gates

Helper utilities in `tests/integration/processors/_helpers.ts`
provide three gate primitives:

- `loadFixture(name)` / `loadFixtureText(name)` — read a committed
  fixture into a `Uint8Array` / UTF-8 string. Throws loudly if
  missing (a fixture is part of the committed corpus; absence is a
  configuration bug, not a skip condition).
- `describeIfBinary(binary, label, fn)` — runs the `fn` body when
  the named CLI binary is on `PATH`. Soft-skips locally when
  missing; **hard-fails** when
  `STORAGE_INTEGRATION_PROCESSORS_REQUIRED=1`. Critically, the
  soft-skip path does NOT evaluate `fn` so processor constructors
  that throw on missing config (e.g. an empty sidecar URL) do not
  crash the runner on a clean laptop.
- `describeIfEnv(envVar, label, fn)` — same posture but gated on a
  service-URL env var (`LIBREOFFICE_SERVICE_URL`, `CLAMD_HOST`,
  etc.) rather than a binary on PATH.

### Per-processor suites

| File | Gate | Suite |
|---|---|---|
| `sharp.integration.test.ts` | always (sharp ships libvips) | Probe JPEG + PNG fixtures; Bug 1 regression guard (variant > 1 KiB for JPEG/WebP/AVIF outputs); GPS EXIF strip invariant for JPEG → JPEG + JPEG → WebP re-encode; dimension-cap defense in depth |
| `ffmpeg.integration.test.ts` | `describeIfBinary('ffmpeg', ...)` | Probe MP4 fixture; Bug 1 regression guard for poster JPEG + transcode fMP4; metadata strip invariant (comment + title NOT in transcode bytes; comment + title NOT in poster bytes) |
| `libreoffice.integration.test.ts` | `describeIfEnv('LIBREOFFICE_SERVICE_URL', ...)` | Bug 1 regression guard for first-page PNG preview; document properties NOT in preview bytes (Title/Author/Creator); unsupported MIME rejection at processor layer |
| `clamav.integration.test.ts` | `CLAMD_HOST` or `CLAMD_SOCKET` set | EICAR detection as `infected` with signature containing `eicar`; clean verdict on benign PDF/PNG fixtures; STORAGE-9 §3.6 invariant (`clean` results carry no signature field) |

### CI integration

New job `integration-processors` in `.github/workflows/ci.yml`:

- Decoupled from the `quality-gates` job so binary-install latency
  does not block fast PR feedback on unit-test failures.
- Sets `STORAGE_INTEGRATION_PROCESSORS_REQUIRED=1` to upgrade the
  soft-skip path to a hard failure (so a CI misconfiguration
  cannot silently hide integration coverage).
- Installs `ffmpeg` via `apt-get install` for the FU-B integration
  suite.
- Runs `clamav/clamav:1.3` as a service container with a
  120-second health-check window for the freshclam signature
  download; the FU-D suite points at it via `CLAMD_HOST=127.0.0.1
  CLAMD_PORT=3310`.
- The libreoffice integration suite is intentionally NOT wired in
  this CI iteration — `LIBREOFFICE_SERVICE_URL` is left unset so
  the suite soft-skips. A future iteration can add a sidecar
  container as a service.

### Out of scope (deferred)

- libreoffice sidecar container in CI (requires the FU-G image to
  be published to a registry CI can pull from).
- Performance benchmarking suite.
- Cross-platform CI matrix (macOS + Windows).
- Visual-regression testing of image / document previews.
