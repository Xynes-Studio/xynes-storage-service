/**
 * STORAGE-7 — enqueue processing jobs for a newly-completed object.
 *
 * Called from the upload `complete` handler (STORAGE-5) AFTER the
 * session has been atomically flipped to `completed` and the object
 * row has been flipped to `uploaded`. This helper:
 *
 *   1. Runs the deterministic planner to produce the job plan.
 *   2. Inserts the planned jobs as `queued` rows in one batch.
 *   3. If at least one job was inserted, flips the parent object to
 *      `processing`. The aggregate-status update is idempotent: if a
 *      concurrent worker has already finished every queued job and
 *      flipped the object to `ready`, we don't clobber that.
 *
 * Returns the inserted job rows so the calling handler can populate the
 * `processingJobs` field of the API response.
 *
 * Failure isolation: this helper deliberately does NOT raise on partial
 * failures of the aggregate-status update — the upload itself has
 * succeeded (the object row is `uploaded`); a slow status-update retry
 * is recoverable later. A failure of the queue insert IS raised — we
 * never want to silently swallow "jobs never enqueued".
 */
import { planProcessingJobs } from './planner';
import type { EnqueueDependencies, EnqueueJobInput, StorageProcessingJobRecord } from './types';
import type { StorageObjectRecord } from '../objects/types';

export interface EnqueueProcessingResult {
  readonly jobs: ReadonlyArray<StorageProcessingJobRecord>;
  /** Set to the updated object when status was flipped, else null. */
  readonly object: StorageObjectRecord | null;
}

export async function enqueueProcessingForObject(
  deps: EnqueueDependencies,
  object: StorageObjectRecord,
): Promise<EnqueueProcessingResult> {
  const plans = planProcessingJobs(object);
  if (plans.length === 0) {
    return { jobs: [], object: null };
  }

  const now = (deps.now ?? (() => new Date()))();
  const idFactory = deps.idFactory ?? (() => crypto.randomUUID());

  const inputs: EnqueueJobInput[] = plans.map((p) => ({
    id: idFactory(),
    objectId: object.id,
    workspaceId: object.workspaceId,
    jobType: p.jobType,
    required: p.required,
    payload: p.payload,
    scheduledAt: now,
  }));

  const jobs = await deps.queue.enqueueBatch(inputs);

  // Flip the parent object to `processing`. If the queue insert succeeded
  // but the status update can't find the row (deleted between complete +
  // enqueue, unusual but possible), we still return the inserted jobs —
  // the worker will discover the deleted object and cancel them.
  const updated = await deps.status.updateAggregateStatus({
    objectId: object.id,
    workspaceId: object.workspaceId,
    nextStatus: 'processing',
    now,
  });

  return { jobs, object: updated };
}
