/**
 * Complete upload session handler.
 *
 * Action key: `platform.storage.objects.upload` (with `operation: 'complete'`).
 *
 * Flow:
 *   1. Validate payload (strict schema).
 *   2. Lookup session for this workspace.
 *      - Not found / wrong workspace -> ValidationError("Upload session not found").
 *      - Already `completed` -> idempotent: return current state.
 *      - `aborted` / `expired` -> ValidationError (state conflict).
 *      - `pending` but past `expires_at` -> mark expired via the session repo
 *        if it supports expiry, otherwise treat as state conflict.
 *   3. Lookup associated object — defensive (the FK guarantees it exists).
 *   4. For multipart sessions: call provider `completeMultipartUpload(parts)`.
 *      Then HEAD both methods and reconcile actual length with declared size and policy.
 *   5. Atomically mark the session `completed` and the object `uploaded`.
 *      If the conditional update misses (concurrent abort), surface a
 *      state conflict.
 *   6. STORAGE-7 will queue async processing jobs here. For STORAGE-5 we
 *      return an empty `processingJobs` array.
 */
import { isValidObjectByteSize, maxBytesForContentType } from '../objects/byte-size-policy';
import { ProviderAdapterError } from '../../../infra/providers/errors';
import { ValidationError, ForbiddenError } from '../../errors';
import type { ActionContext } from '../../types';
import { toPublicObject, toPublicSession } from './responses';
import type { CompleteUploadSessionResponse } from './responses';
import { completeUploadPayloadSchema, type CompleteUploadPayload } from './schemas';
import type { UploadHandlerDependencies } from './types';

export function createCompleteUploadHandler(deps: UploadHandlerDependencies) {
  const now = deps.now ?? (() => new Date());

  return async (payload: unknown, ctx: ActionContext): Promise<CompleteUploadSessionResponse> => {
    const parseResult = completeUploadPayloadSchema.safeParse(payload);
    if (!parseResult.success) {
      throw new ValidationError(parseResult.error.issues[0]?.message ?? 'Invalid payload');
    }
    const input: CompleteUploadPayload = parseResult.data;

    const session = await deps.sessions.findByIdForWorkspace({
      sessionId: input.uploadId,
      workspaceId: ctx.workspaceId,
    });
    if (!session) {
      // Cross-workspace denial AND not-found share the same envelope so
      // a hostile caller cannot probe other workspaces' session ids.
      throw new ValidationError('Upload session not found');
    }

    // Idempotency: completing an already-completed session re-emits its
    // current state without re-touching the provider or the DB.
    if (session.status === 'completed') {
      const object = await deps.objects.findByIdForWorkspace({
        objectId: session.objectId,
        workspaceId: ctx.workspaceId,
      });
      if (!object) {
        // FK invariant violated — surface as a state conflict.
        throw new ValidationError('Upload session is in an inconsistent state');
      }
      return {
        object: toPublicObject(object),
        session: toPublicSession(session),
        processingJobs: [],
      };
    }

    if (session.status === 'aborted') {
      throw new ValidationError('Upload session has already been aborted');
    }
    if (session.status === 'expired') {
      throw new ValidationError('Upload session has expired');
    }

    // `session.status === 'pending'` from here on.
    const issuedAt = now();
    if (session.expiresAt.getTime() <= issuedAt.getTime()) {
      throw new ValidationError('Upload session has expired');
    }

    const object = await deps.objects.findByIdForWorkspace({
      objectId: session.objectId,
      workspaceId: ctx.workspaceId,
    });
    if (!object) {
      throw new ValidationError('Upload session is in an inconsistent state');
    }

    const provider = await deps.providers.resolveDefaultForWorkspace(ctx.workspaceId);
    if (!provider) {
      throw new ForbiddenError(
        'Workspace has no storage provider configured. Contact a workspace admin.',
      );
    }

    // Multipart: complete on the provider with the supplied part list.
    if (session.uploadMethod === 'multipart') {
      if (!session.providerUploadId) {
        throw new ValidationError('Upload session is in an inconsistent state');
      }
      if (!input.parts || input.parts.length === 0) {
        throw new ValidationError('Multipart complete requires `parts`');
      }
      try {
        await provider.adapter.completeMultipartUpload({
          objectKey: object.providerObjectKey,
          providerUploadId: session.providerUploadId,
          parts: input.parts,
        });
      } catch (err) {
        // A previous attempt may have finalized the provider upload, then
        // failed HEAD or the local transition. Recover ONLY a missing handle;
        // the HEAD + size check below remains mandatory.
        if (!(err instanceof ProviderAdapterError) || err.code !== 'PROVIDER_MULTIPART_NOT_FOUND') {
          throw err;
        }
      }
    }

    // Completion is never evidence of size. HEAD both methods before
    // transitioning state or scheduling any processing.
    const head = await provider.adapter.headObject({ objectKey: object.providerObjectKey });
    if (
      !isValidObjectByteSize(head.contentLength) ||
      !isValidObjectByteSize(object.byteSize) ||
      head.contentLength !== object.byteSize ||
      head.contentLength > maxBytesForContentType(object.contentType)
    ) {
      await deps.sessions.markAbortedIfPending({
        sessionId: session.id,
        workspaceId: ctx.workspaceId,
        now: issuedAt,
      });
      // Do not delete provider bytes here: a concurrent completion may
      // own the object. Retain it for operator cleanup.
      throw new ValidationError('Uploaded object size is invalid');
    }

    // Atomic state transition: pending -> completed, AND object pending_upload -> uploaded.
    const updatedSession = await deps.sessions.markCompletedIfPending({
      sessionId: session.id,
      workspaceId: ctx.workspaceId,
      now: issuedAt,
    });
    if (!updatedSession) {
      // Lost a race with another request. Re-check current state for a
      // helpful error.
      const re = await deps.sessions.findByIdForWorkspace({
        sessionId: session.id,
        workspaceId: ctx.workspaceId,
      });
      if (re?.status === 'completed') {
        // Race resolved to "completed". Treat as idempotent success.
        const o = await deps.objects.findByIdForWorkspace({
          objectId: re.objectId,
          workspaceId: ctx.workspaceId,
        });
        if (o) {
          return {
            object: toPublicObject(o),
            session: toPublicSession(re),
            processingJobs: [],
          };
        }
      }
      throw new ValidationError('Upload session is no longer pending');
    }

    const updatedObject = await deps.objects.markUploaded({
      objectId: object.id,
      workspaceId: ctx.workspaceId,
      sha256: input.sha256 ?? object.sha256,
    });
    if (!updatedObject) {
      // Should not happen given the FK and the workspace scope, but treat
      // it as a state conflict rather than a 500.
      throw new ValidationError('Upload session is in an inconsistent state');
    }

    // STORAGE-7: enqueue async processing jobs. The callback is optional
    // — when unset (STORAGE-5 default), `processingJobs` stays empty.
    // Failures inside the callback MUST NOT undo the upload-complete
    // success — the upload itself is durable at this point.
    let processingJobs: ReadonlyArray<unknown> = [];
    if (deps.enqueueProcessing) {
      try {
        processingJobs = await deps.enqueueProcessing({
          objectId: updatedObject.id,
          workspaceId: ctx.workspaceId,
        });
      } catch {
        // Swallow — the worker scheduler will pick up the unprocessed
        // object on its next pass.
        processingJobs = [];
      }
    }

    return {
      object: toPublicObject(updatedObject),
      session: toPublicSession(updatedSession),
      processingJobs,
    };
  };
}

export type { ProviderAdapterError };
