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

    return {
      uploadId: created.session.id,
      objectId: created.object.id,
      uploadMethod,
      uploadUrl,
      uploadHeaders,
      parts,
      expiresAt: created.session.expiresAt.toISOString(),
      object: toPublicObject(created.object),
    };
  };
}

/** Re-export so tests can import the type alongside the factory. */
export type { ProviderAdapterError };
