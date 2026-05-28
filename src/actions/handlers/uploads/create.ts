/**
 * Create upload session handler.
 *
 * Action key: `platform.storage.objects.upload` (with `operation: 'create'`).
 *
 * Flow:
 *   1. Validate payload (strict schema).
 *   2. Resolve workspace default provider — fail closed if none.
 *   3. Derive an unguessable provider object key (workspace + UUID).
 *   4. Decide single vs multipart based on `byteSize` vs threshold.
 *   5. Insert object + session row atomically (rolls back on insert error).
 *   6. Sign upload URL(s) via the adapter.
 *   7. Return public DTO with documented fields only.
 */
import { randomUUID } from 'node:crypto';
import { ProviderAdapterError } from '../../../infra/providers/errors';
import { MULTIPART_MAX_PART_COUNT, MULTIPART_MIN_PART_SIZE } from '../../../infra/providers/types';
import { ValidationError, ForbiddenError } from '../../errors';
import type { ActionContext } from '../../types';
import { getOptionalUserId } from '../../guards';
import { deriveProviderObjectKey } from './object-keys';
import { toPublicObject } from './responses';
import type { CreateUploadSessionPartUrl, CreateUploadSessionResponse } from './responses';
import {
  DEFAULT_UPLOAD_PURPOSE,
  createUploadPayloadSchema,
  type CreateUploadPayload,
} from './schemas';
import type { UploadHandlerDependencies, UploadMethod } from './types';

const DEFAULT_SESSION_TTL_SECONDS = 15 * 60; // 15 min — matches presign default.
const MIN_SESSION_TTL_SECONDS = 60;
const MAX_SESSION_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_MULTIPART_THRESHOLD = 100 * 1024 * 1024; // 100 MB (AWS guidance).

/** DEDUP-2 default owner kind for callers that omit `ownerKind`. */
const DEFAULT_OWNER_KIND = 'platform_generic' as const;

function clampTtlSeconds(ttl: number): number {
  if (!Number.isFinite(ttl)) return DEFAULT_SESSION_TTL_SECONDS;
  if (ttl < MIN_SESSION_TTL_SECONDS) return MIN_SESSION_TTL_SECONDS;
  if (ttl > MAX_SESSION_TTL_SECONDS) return MAX_SESSION_TTL_SECONDS;
  return Math.floor(ttl);
}

function decideMultipart(byteSize: number, threshold: number): UploadMethod {
  return byteSize > threshold ? 'multipart' : 'single';
}

/**
 * Compute part count for multipart uploads. Strategy: use parts of the
 * minimum part size (5 MiB), capped at `MULTIPART_MAX_PART_COUNT` (10 000).
 *
 * - For files just above the threshold, this yields a small number of
 *   parts (e.g. 200 MB → 40 parts).
 * - For very large files (> 5 MiB × 10 000 = ~50 GiB), we scale the part
 *   size up so the count stays ≤ 10 000.
 */
export function planMultipartParts(byteSize: number): number {
  if (byteSize <= 0) return 1;
  const minParts = Math.ceil(byteSize / MULTIPART_MIN_PART_SIZE);
  if (minParts <= MULTIPART_MAX_PART_COUNT) {
    return Math.max(1, minParts);
  }
  return MULTIPART_MAX_PART_COUNT;
}

export function createCreateUploadHandler(deps: UploadHandlerDependencies) {
  const now = deps.now ?? (() => new Date());
  const idFactory = deps.idFactory ?? (() => randomUUID());
  const ttl = clampTtlSeconds(deps.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS);
  const multipartThreshold = deps.multipartThresholdBytes ?? DEFAULT_MULTIPART_THRESHOLD;

  return async (payload: unknown, ctx: ActionContext): Promise<CreateUploadSessionResponse> => {
    const parseResult = createUploadPayloadSchema.safeParse(payload);
    if (!parseResult.success) {
      throw new ValidationError(parseResult.error.issues[0]?.message ?? 'Invalid payload');
    }
    const input: CreateUploadPayload = parseResult.data;

    // DEDUP-2 — content-hash dedup short-circuit.
    //
    // When the caller supplies a `sha256` AND the service is wired with
    // a `references` repository, we probe `platform.storage_objects` for
    // an existing row in this workspace with the same content hash whose
    // status is `uploaded` / `processing` / `ready`. On a hit, we attach
    // a reference row (idempotent on the composite PK) and return the
    // EXISTING object with `dedupHit: true`. The provider URL is NEVER
    // minted — the bytes are already there.
    //
    // Security: the probe is workspace-scoped at the SQL layer
    // (`findExistingByWorkspaceSha256`). Cross-workspace dedup is
    // structurally impossible — the DEDUP-1 partial unique index keys
    // on `(workspace_id, sha256)`, never on `sha256` alone, so two
    // workspaces with the same content do NOT see each other.
    //
    // Backward compatibility: a caller without `sha256` (legacy
    // STORAGE-5 path) bypasses the probe entirely. A service without
    // `deps.references` wired bypasses it too — STORAGE-5 / STORAGE-6
    // tests stay green byte-for-byte.
    if (input.sha256 !== undefined && deps.references !== undefined) {
      const existing = await deps.objects.findExistingByWorkspaceSha256({
        workspaceId: ctx.workspaceId,
        sha256: input.sha256,
      });
      if (existing !== null) {
        const ownerKind = input.ownerKind ?? DEFAULT_OWNER_KIND;
        const ownerId = input.ownerId ?? idFactory();
        // Idempotent reference insert — composite PK collision -> no-op.
        await deps.references.addReference({
          objectId: existing.id,
          workspaceId: ctx.workspaceId,
          ownerKind,
          ownerId,
        });
        return {
          // Reuse the EXISTING object's id as the response identifier.
          // No new session row is created — there's nothing to complete
          // or abort. Callers detect this via `dedupHit: true` and skip
          // the provider PUT + the `complete` round-trip.
          uploadId: existing.id,
          objectId: existing.id,
          uploadMethod: 'single',
          uploadUrl: null,
          uploadHeaders: {},
          parts: [],
          // `expiresAt` is still a string for shape parity with the
          // fresh-upload path. We surface the existing object's
          // `updatedAt` so the field is always meaningful, never a
          // bogus "now + 15min" that hints at a non-existent session.
          expiresAt: existing.updatedAt.toISOString(),
          object: toPublicObject(existing),
          dedupHit: true,
        };
      }
    }

    const provider = await deps.providers.resolveDefaultForWorkspace(ctx.workspaceId);
    if (!provider) {
      // 403-style envelope is reused here because "no provider configured"
      // is operationally a workspace-admin state, not a "we lost the row"
      // bug. The error message is deliberately generic — it MUST NOT carry
      // any provider config or credential reference.
      throw new ForbiddenError(
        'Workspace has no storage provider configured. Contact a workspace admin.',
      );
    }

    const objectId = idFactory();
    const sessionId = idFactory();
    const providerObjectKey = deriveProviderObjectKey({
      workspaceId: ctx.workspaceId,
      objectId,
      filename: input.filename,
    });

    const purpose = input.purpose ?? DEFAULT_UPLOAD_PURPOSE;
    const visibility = input.visibility ?? 'private';
    const compression = input.compression ?? true;
    const uploadMethod = decideMultipart(input.byteSize, multipartThreshold);
    const issuedAt = now();
    const expiresAt = new Date(issuedAt.getTime() + ttl * 1000);

    // Sign upload URLs BEFORE we persist — so a provider-side failure
    // never leaves an orphan object/session row. The adapter pre-redacts
    // its errors (STORAGE-4 contract), so re-throwing here is safe.
    let uploadUrl: string | null = null;
    let uploadHeaders: Record<string, string> = {};
    let providerUploadId: string | null = null;
    const parts: CreateUploadSessionPartUrl[] = [];

    if (uploadMethod === 'single') {
      const single = await provider.adapter.createSingleUploadUrl({
        objectKey: providerObjectKey,
        contentType: input.contentType,
        contentLength: input.byteSize,
        expiresInSeconds: ttl,
      });
      uploadUrl = single.url;
      uploadHeaders = { ...single.headers };
    } else {
      const handle = await provider.adapter.createMultipartUpload({
        objectKey: providerObjectKey,
        contentType: input.contentType,
      });
      providerUploadId = handle.providerUploadId;
      const partCount = planMultipartParts(input.byteSize);
      for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
        const part = await provider.adapter.signMultipartPart({
          objectKey: providerObjectKey,
          providerUploadId: handle.providerUploadId,
          partNumber,
          expiresInSeconds: ttl,
        });
        parts.push({
          partNumber: part.partNumber,
          url: part.url,
          expiresAt: part.expiresAt.toISOString(),
        });
      }
    }

    // Atomic insert: object + session in one transaction.
    let created;
    try {
      created = await deps.sessions.createObjectWithSession({
        objectId,
        sessionId,
        workspaceId: ctx.workspaceId,
        providerId: provider.providerId,
        providerObjectKey,
        filename: input.filename,
        contentType: input.contentType,
        byteSize: input.byteSize,
        sha256: input.sha256 ?? null,
        purpose,
        visibility,
        compressionRequested: compression,
        uploadMethod,
        providerUploadId,
        expiresAt,
        createdBy: getOptionalUserId(ctx),
      });
    } catch (err) {
      // If the DB insert failed AFTER we minted a multipart upload on the
      // provider, abort the multipart so we don't leak orphan storage
      // there. The adapter abort is best-effort: a failure here is
      // logged at the caller layer (error handler) — we re-throw the
      // ORIGINAL DB error so the operator sees the real cause.
      if (providerUploadId) {
        try {
          await provider.adapter.abortMultipartUpload({
            objectKey: providerObjectKey,
            providerUploadId,
          });
        } catch {
          // Swallow: original error is more informative.
        }
      }
      // Re-throw so the route-level error handler returns a redacted envelope.
      throw err;
    }

    // DEDUP-2 — when a fresh upload completes the create flow AND the
    // caller supplied owner metadata, attach a reference row so the
    // delete handler can decrement it later. The insert is idempotent
    // (composite PK on `(object_id, owner_kind, owner_id)`); failures
    // are swallowed so a reference-table outage cannot block a
    // legitimate upload (worst case: the object is created without a
    // reference and behaves like a legacy STORAGE-6 object).
    if (deps.references !== undefined) {
      const ownerKind = input.ownerKind ?? DEFAULT_OWNER_KIND;
      const ownerId = input.ownerId ?? idFactory();
      try {
        await deps.references.addReference({
          objectId: created.object.id,
          workspaceId: ctx.workspaceId,
          ownerKind,
          ownerId,
        });
      } catch {
        // Best-effort: a transient FK / write failure must NOT undo the
        // already-persisted object + session. The reference can be
        // re-attached lazily by a future call (idempotent insert).
      }
    }

    return {
      uploadId: created.session.id,
      objectId: created.object.id,
      uploadMethod,
      uploadUrl,
      uploadHeaders,
      parts,
      expiresAt: created.session.expiresAt.toISOString(),
      object: toPublicObject(created.object),
      dedupHit: false,
    };
  };
}

/** Re-export so tests can import the type alongside the factory. */
export type { ProviderAdapterError };
