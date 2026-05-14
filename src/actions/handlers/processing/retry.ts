/**
 * STORAGE-7 — retry handler for `platform.storage.objects.process.retry`.
 *
 * Requeues every terminally-`failed` job for an object. The repo
 * contract requires the implementation to:
 *   - Find every job belonging to the object that is in `failed`.
 *   - Atomically flip them back to `queued`, reset `attempts = 0`,
 *     clear `errorCode`, stamp `scheduledAt = now`.
 *   - NEVER touch `running` jobs — those are owned by a worker.
 *
 * After requeue, the handler:
 *   - Re-fetches the full job list.
 *   - Computes the aggregate status (back to `processing` if there are
 *     pending required jobs; otherwise unchanged).
 *   - Flips the object's aggregate accordingly.
 *
 * SECURITY: the handler enforces workspace ownership at every step —
 * cross-workspace `objectId` probes return the same "not found"
 * envelope as truly-unknown ids. The response shape carries only the
 * public processing-job DTO and the updated public object DTO — no
 * provider config or credentials.
 */
import { computeAggregateStatus } from './aggregator';
import { retryProcessingPayloadSchema, type RetryProcessingPayload } from './schemas';
import type { RetryHandlerDependencies } from './types';
import {
  toPublicObject,
  toPublicProcessingJob,
  type PublicProcessingJob,
  type PublicStorageObject,
} from '../objects/responses';
import { ValidationError } from '../../errors';
import type { ActionContext } from '../../types';

export interface RetryProcessingResponse {
  readonly object: PublicStorageObject;
  readonly requeuedJobs: ReadonlyArray<PublicProcessingJob>;
}

export function createRetryProcessingHandler(deps: RetryHandlerDependencies) {
  const now = deps.now ?? (() => new Date());

  return async (payload: unknown, ctx: ActionContext): Promise<RetryProcessingResponse> => {
    const parsed = retryProcessingPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid payload');
    }
    const input: RetryProcessingPayload = parsed.data;

    // Workspace-scoped object lookup. Cross-workspace probe returns the
    // same "not found" envelope as truly-unknown ids — no enumeration.
    const object = await deps.objects.findByIdForWorkspace({
      objectId: input.objectId,
      workspaceId: ctx.workspaceId,
    });
    if (!object) {
      throw new ValidationError('Object not found');
    }
    if (object.status === 'deleted') {
      // Deleted is the same envelope as not-found.
      throw new ValidationError('Object not found');
    }

    const issuedAt = now();
    const requeued = await deps.queue.requeueFailedForObject({
      objectId: object.id,
      workspaceId: ctx.workspaceId,
      now: issuedAt,
    });

    // Re-compute aggregate from the FULL job list after the requeue.
    const all = await deps.queue.listForObject({
      objectId: object.id,
      workspaceId: ctx.workspaceId,
    });
    const nextStatus = computeAggregateStatus(
      all.map((j) => ({ status: j.status, required: j.required })),
    );

    let updatedObject = object;
    if (nextStatus) {
      const u = await deps.status.updateAggregateStatus({
        objectId: object.id,
        workspaceId: ctx.workspaceId,
        nextStatus,
        now: issuedAt,
      });
      if (u) updatedObject = u;
    }

    return {
      object: toPublicObject(updatedObject),
      requeuedJobs: requeued.map(toPublicProcessingJob),
    };
  };
}
