/**
 * STORAGE-6 — soft-delete a storage object.
 *
 * Action key: `platform.storage.objects.delete` (with `operation: 'delete'`).
 *
 * Flow:
 *   1. Validate payload.
 *   2. Lookup object scoped to workspace.
 *      - Not found / wrong workspace -> `ValidationError("Object not found")`.
 *      - Already `deleted` -> idempotent: return current state without
 *        calling the provider again.
 *   3. Soft-delete the row (atomic: marks `status = 'deleted'`, stamps
 *      `deleted_at`, leaves the row in place for audit).
 *   4. Best-effort call provider `deleteObject(providerObjectKey)`.
 *      Provider errors are pre-redacted by the adapter (STORAGE-4
 *      contract). `ProviderAdapterError` is SWALLOWED — STORAGE-9
 *      cleanup-job posture: the local DB row MUST flip even if the
 *      provider transient-errors. The cleanup job picks up orphan
 *      provider objects later.
 *   5. Return the soft-deleted object DTO.
 *
 * NOTE: This is "soft-delete" — the canonical row is preserved with
 * `status = 'deleted'` for audit purposes. Workspace retention policy
 * (out of scope for STORAGE-6) decides when the row is GC'd.
 */
import { ProviderAdapterError } from '../../../infra/providers/errors';
import { ValidationError } from '../../errors';
import type { ActionContext } from '../../types';
import { toPublicObject } from './responses';
import type { DeleteObjectResponse } from './responses';
import { deleteObjectPayloadSchema } from './schemas';
import type { ObjectsHandlerDependencies } from './types';

export function createDeleteObjectHandler(deps: ObjectsHandlerDependencies) {
  const now = deps.now ?? (() => new Date());

  return async (payload: unknown, ctx: ActionContext): Promise<DeleteObjectResponse> => {
    const parseResult = deleteObjectPayloadSchema.safeParse(payload);
    if (!parseResult.success) {
      throw new ValidationError(parseResult.error.issues[0]?.message ?? 'Invalid payload');
    }
    const { objectId } = parseResult.data;

    const object = await deps.objects.findByIdForWorkspace({
      objectId,
      workspaceId: ctx.workspaceId,
    });
    if (!object) {
      throw new ValidationError('Object not found');
    }
    if (object.status === 'deleted') {
      // Idempotent — repeat call returns current state.
      return { object: toPublicObject(object) };
    }

    const softDeleted = await deps.objects.softDeleteForWorkspace({
      objectId,
      workspaceId: ctx.workspaceId,
      now: now(),
    });
    if (!softDeleted) {
      // Lost a race with a concurrent delete. Re-read.
      const re = await deps.objects.findByIdForWorkspace({
        objectId,
        workspaceId: ctx.workspaceId,
      });
      if (re?.status === 'deleted') {
        return { object: toPublicObject(re) };
      }
      throw new ValidationError('Object not found');
    }

    // Best-effort provider-side delete. Swallowing ProviderAdapterError is
    // intentional: the local row is the source of truth, and a transient
    // provider failure must not prevent the soft-delete from succeeding.
    // The cleanup-job (out of scope for STORAGE-6) reconciles orphans.
    const provider = await deps.providers.resolveByProviderIdForWorkspace({
      workspaceId: ctx.workspaceId,
      providerId: softDeleted.providerId,
    });
    if (provider) {
      try {
        await provider.adapter.deleteObject({ objectKey: softDeleted.providerObjectKey });
      } catch (err) {
        if (!(err instanceof ProviderAdapterError)) {
          throw err;
        }
        // Adapter pre-redacted the error; we swallow to honour the
        // soft-delete contract. STORAGE-9 cleanup picks up the orphan.
      }
    }

    return { object: toPublicObject(softDeleted) };
  };
}
