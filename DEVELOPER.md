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
is a one-liner once sharp / ffmpeg / libreoffice bindings (or remote
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
| STORAGE-FU-3 | ✅ Landed 2026-05-15 (Provider resolver + secret-manager interface) |

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
  `STORAGE_CREDENTIAL_STORAGE__R2__DEV` injective mapping — see
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

- **Hosted secret-manager implementations.** Each (AWS Secrets Manager,
  GCP Secret Manager, Doppler, Vault) is a separate per-environment
  follow-up story per the plan's §6. STORAGE-FU-3 ships the interface
  and the local-dev env-backed implementation.
- **Composition root wiring.** That's STORAGE-FU-4.
- **Provider failover automation.** Plan §13 "out of scope".
- **BYOS credential rotation UX.** That's the workspace-admin
  integrations epic, not STORAGE.
