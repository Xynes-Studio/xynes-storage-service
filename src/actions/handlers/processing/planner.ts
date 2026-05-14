/**
 * STORAGE-7 — processing job planner.
 *
 * `planProcessingJobs(object)` is a deterministic, side-effect-free
 * function that maps a completed `StorageObjectRecord` onto the list of
 * processing jobs the worker should run.
 *
 * Rules (matches plan STORAGE-7 acceptance criteria):
 *   - EVERY upload yields at least a `scan_validation` job (required).
 *   - **Images** with `compressionRequested = true` yield an
 *     `image_optimize` job (not required — best-effort, must not block
 *     `ready` if image processing breaks).
 *   - **Videos** with `compressionRequested = true` yield three jobs:
 *     - `video_probe`     (required: ffprobe metadata is the safety gate)
 *     - `video_thumbnail` (not required)
 *     - `video_transcode` (not required)
 *   - **Documents** yield a single non-required `document_preview` job
 *     ONLY when the content type is on the safe-preview allowlist
 *     (PDF + a small set of office formats). Unknown documents,
 *     archives, audio, and `other` content yield only the
 *     scan/validation job.
 *   - Compression-disabled uploads still scan/validate; they just never
 *     enqueue compression-derivative jobs.
 *   - `pending_upload` / `deleted` / already-`ready` / already-`failed`
 *     objects MUST NOT have jobs planned for them — only `uploaded`
 *     objects are eligible.
 *
 * The planner is purely a function of (contentType, compressionRequested,
 * status). It NEVER touches the queue, the provider, or the DB.
 */
import { classifyContentType } from '../objects/schemas';
import type { StorageObjectRecord } from '../objects/types';
import type { ProcessingJobPlan } from './types';

const SAFE_DOCUMENT_PREVIEW_MIMES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'application/rtf',
]);

/**
 * Returns the deterministic processing-job plan for an object.
 *
 * Returns `[]` for objects in a state where processing is not allowed
 * (anything other than `uploaded`). This lets the enqueue helper treat
 * "no jobs" as a non-error short-circuit.
 */
export function planProcessingJobs(object: StorageObjectRecord): ProcessingJobPlan[] {
  if (object.status !== 'uploaded') {
    return [];
  }

  const plans: ProcessingJobPlan[] = [];

  // 1) Every upload gets scan/validation. Always required.
  plans.push({
    jobType: 'scan_validation',
    required: true,
    payload: {
      contentType: object.contentType,
      byteSize: object.byteSize,
    },
  });

  if (!object.compressionRequested) {
    return plans;
  }

  const family = classifyContentType(object.contentType);

  if (family === 'image') {
    plans.push({
      jobType: 'image_optimize',
      required: false,
      payload: {
        // The runner resolves the provider via the resolver at run time.
        // We deliberately do NOT push provider config here.
        contentType: object.contentType,
      },
    });
    return plans;
  }

  if (family === 'video') {
    plans.push({
      jobType: 'video_probe',
      required: true,
      payload: { contentType: object.contentType },
    });
    plans.push({
      jobType: 'video_thumbnail',
      required: false,
      payload: { contentType: object.contentType },
    });
    plans.push({
      jobType: 'video_transcode',
      required: false,
      payload: { contentType: object.contentType },
    });
    return plans;
  }

  if (family === 'document' && SAFE_DOCUMENT_PREVIEW_MIMES.has(object.contentType.toLowerCase())) {
    plans.push({
      jobType: 'document_preview',
      required: false,
      payload: { contentType: object.contentType },
    });
    return plans;
  }

  // Audio / archive / text / other / unknown documents: scan only.
  return plans;
}

/**
 * Helper exposed for tests: returns the *set* of job types the planner
 * would emit (without payloads). Useful for parameterised tests over
 * many content types.
 */
export function planProcessingJobTypes(object: StorageObjectRecord): string[] {
  return planProcessingJobs(object).map((p) => p.jobType);
}
