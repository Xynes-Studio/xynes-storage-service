/**
 * STORAGE-7 — object aggregate status computation.
 *
 * Given the full list of processing jobs for an object, compute the
 * object's aggregate `ObjectStatus`. Matches the plan STORAGE-7 contract:
 *
 *   - `processing` while ≥ 1 **required** job is `queued` or `running`
 *   - `failed`     when ≥ 1 **required** job is terminally `failed`
 *   - `ready`      when all **required** jobs are `succeeded`
 *
 * Non-required jobs (best-effort variants — thumbnails, transcodes,
 * document previews) NEVER block `ready` and NEVER flip the parent to
 * `failed`. A transient ffmpeg failure must not ruin an otherwise-good
 * upload.
 *
 * `cancelled` jobs are treated as non-blocking (same posture as
 * succeeded).
 *
 * The function MUST be a pure function of the job list — no clock, no
 * I/O. The caller is responsible for fetching the jobs and passing them
 * in.
 */
import type { ObjectStatus, StorageProcessingJobRecord } from './types';

export type AggregateObjectStatus = Extract<ObjectStatus, 'processing' | 'ready' | 'failed'>;

/**
 * Compute the aggregate status from a list of jobs.
 *
 * Returns `null` when the list is empty — the caller should leave the
 * object's status untouched (an `uploaded` object with no planned jobs
 * is a planner bug, but we defensively never collapse to `failed` for it).
 *
 * Aggregate is computed by partitioning the REQUIRED jobs:
 *
 *   any required failed  -> failed
 *   any required pending -> processing
 *   else                 -> ready
 *
 * Non-required jobs are inspected only as "no required ones" → the
 * presence of a queued/running non-required job alone does NOT keep the
 * parent in `processing` once all required ones are done. This matches
 * the product principle: "compression failures must not lose drafts."
 */
export function computeAggregateStatus(
  jobs: ReadonlyArray<Pick<StorageProcessingJobRecord, 'status'> & { readonly required: boolean }>,
): AggregateObjectStatus | null {
  if (jobs.length === 0) return null;

  const required = jobs.filter((j) => j.required);
  // If a planner emitted only non-required jobs (unusual but defensible
  // for some future flow) treat all jobs as "soft" and base the answer
  // on the WHOLE list — but a single failed-soft job MUST NOT flip the
  // parent to `failed`. So even in that degenerate case we never emit
  // `failed` for a soft-only set.
  const probe = required.length > 0 ? required : jobs;

  let pending = 0;
  let failed = 0;
  let succeeded = 0;
  let other = 0;
  for (const j of probe) {
    if (j.status === 'queued' || j.status === 'running') pending += 1;
    else if (j.status === 'failed') failed += 1;
    else if (j.status === 'succeeded') succeeded += 1;
    else other += 1; // cancelled
  }

  if (required.length > 0 && failed > 0) return 'failed';
  if (pending > 0) return 'processing';
  // All required ones are terminal and none failed → ready.
  // (`succeeded + other` accounts for cancelled non-failures.)
  if (succeeded > 0 || other > 0 || required.length === 0) return 'ready';
  return 'ready';
}
