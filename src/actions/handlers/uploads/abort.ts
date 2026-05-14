/**
 * Abort upload session handler.
 *
 * Action key: `platform.storage.objects.upload` (with `operation: 'abort'`).
 *
 * Flow:
 *   1. Validate payload.
 *   2. Lookup session for this workspace.
 *      - Not found / wrong workspace -> ValidationError (same envelope as complete).
 *      - Already `aborted` -> idempotent: return current state.
 *      - `completed` -> ValidationError (cannot abort a completed upload).
 *      - `expired` -> idempotent: return current state (treat as terminal).
 *   3. For multipart sessions, call provider `abortMultipartUpload`.
 *      Provider errors are wrapped in `ProviderAdapterError` by the adapter,
 *      which is already pre-redacted (STORAGE-4 contract). Some providers
 *      return `NoSuchUpload` (404) for already-aborted multiparts; that
 *      surfaces as `PROVIDER_OPERATION_FAILED` here. We swallow that so
 *      the local DB row still flips to `aborted` — without this, a transient
 *      provider hiccup could permanently prevent abort cleanup.
 *   4. Atomically mark the session `aborted`.
 */
import { ProviderAdapterError } from '../../../infra/providers/errors';
import { ValidationError } from '../../errors';
import type { ActionContext } from '../../types';
import { toPublicSession } from './responses';
import type { AbortUploadSessionResponse } from './responses';
import { abortUploadPayloadSchema, type AbortUploadPayload } from './schemas';
import type { UploadHandlerDependencies } from './types';

export function createAbortUploadHandler(deps: UploadHandlerDependencies) {
  const now = deps.now ?? (() => new Date());

  return async (payload: unknown, ctx: ActionContext): Promise<AbortUploadSessionResponse> => {
    const parseResult = abortUploadPayloadSchema.safeParse(payload);
    if (!parseResult.success) {
      throw new ValidationError(parseResult.error.issues[0]?.message ?? 'Invalid payload');
    }
    const input: AbortUploadPayload = parseResult.data;

    const session = await deps.sessions.findByIdForWorkspace({
      sessionId: input.uploadId,
      workspaceId: ctx.workspaceId,
    });
    if (!session) {
      throw new ValidationError('Upload session not found');
    }

    if (session.status === 'aborted' || session.status === 'expired') {
      // Idempotent: return current state without re-touching the provider.
      return { session: toPublicSession(session) };
    }
    if (session.status === 'completed') {
      throw new ValidationError('Upload session has already been completed');
    }

    // `pending` from here.
    if (session.uploadMethod === 'multipart' && session.providerUploadId) {
      const object = await deps.objects.findByIdForWorkspace({
        objectId: session.objectId,
        workspaceId: ctx.workspaceId,
      });
      if (object) {
        const provider = await deps.providers.resolveDefaultForWorkspace(ctx.workspaceId);
        if (provider) {
          try {
            await provider.adapter.abortMultipartUpload({
              objectKey: object.providerObjectKey,
              providerUploadId: session.providerUploadId,
            });
          } catch (err) {
            // ProviderAdapterError is pre-redacted. NoSuchUpload / already-aborted
            // on the provider side is fine — we still need to flip the local
            // session row. Swallowing here is the documented STORAGE-9
            // cleanup-job behaviour: treat 404 / NoSuchUpload as success.
            if (!(err instanceof ProviderAdapterError)) {
              throw err;
            }
          }
        }
      }
    }

    const aborted = await deps.sessions.markAbortedIfPending({
      sessionId: session.id,
      workspaceId: ctx.workspaceId,
      now: now(),
    });
    if (!aborted) {
      // Lost a race. Re-read for a current-state envelope.
      const re = await deps.sessions.findByIdForWorkspace({
        sessionId: session.id,
        workspaceId: ctx.workspaceId,
      });
      if (re?.status === 'aborted' || re?.status === 'expired') {
        return { session: toPublicSession(re) };
      }
      if (re?.status === 'completed') {
        throw new ValidationError('Upload session has already been completed');
      }
      throw new ValidationError('Upload session is no longer pending');
    }

    return { session: toPublicSession(aborted) };
  };
}
