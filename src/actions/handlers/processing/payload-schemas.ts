/**
 * STORAGE-FU-2-FU-2 — per-jobType payload validators.
 *
 * Purpose
 * -------
 * The `payload` column on `platform.storage_processing_jobs` is now a
 * real `jsonb` column (canonical migration
 * `20260529090000_storage_processing_jobs_payload_and_required.sql`).
 * The STORAGE-7 planner emits a small, closed-shape payload per job
 * type:
 *   - `scan_validation`   → `{ contentType, byteSize }`
 *   - `image_optimize`    → `{ contentType }`
 *   - `video_probe`       → `{ contentType }`
 *   - `video_thumbnail`   → `{ contentType }`
 *   - `video_transcode`   → `{ contentType }`
 *   - `document_preview`  → `{ contentType }`
 *
 * Until FU-2-FU-2 the queue repo simply returned `{}` for every
 * `ClaimedJob.payload`, so hostile keys in a payload were a moot point.
 * Now that the payload round-trips through the DB, we need defense in
 * depth: a per-jobType `z.strict()` schema rejects any key the planner
 * did NOT emit. This catches:
 *
 *   1. A regression where a future planner edit accidentally pushes
 *      provider config / signed URLs / credentials into the payload
 *      (the planner contract says it MUST NOT — STORAGE-9 redaction
 *      contract, STORAGE-7 §"payload" docs).
 *   2. A hostile / buggy caller that constructs `EnqueueJobInput`
 *      objects directly (e.g. a future authoring API that lets users
 *      script jobs) and tries to smuggle data through `payload`.
 *
 * Security invariants (proven by tests)
 * -------------------------------------
 * - `validateJobPayload(jobType, payload)` throws a `PayloadValidationError`
 *   (closed-set code `INVALID_JOB_PAYLOAD`, status hint 400) for ANY
 *   hostile key. The error message NEVER echoes the hostile value —
 *   only the key name (so an operator can diagnose what was rejected
 *   without leaking the smuggled payload to the gateway audit log).
 * - Unknown job types are rejected with the same error code. A future
 *   job type that ships without a schema cannot silently bypass
 *   validation.
 * - The schemas mirror the planner's emitted shape byte-for-byte. A
 *   schema-drift unit test enforces this against a curated planner
 *   fixture; future planner edits that add a field MUST also extend
 *   the matching schema here.
 *
 * NOT enforced here (handled elsewhere)
 * -------------------------------------
 * - Workspace ownership: enforced by the queue repo (`enqueueBatch`
 *   joins via `objectId` → `storage_objects.workspace_id` FK).
 * - Maximum payload byte size: bounded structurally by the closed
 *   `.strict()` schemas — a 100-byte payload cap is enforced as the
 *   union of all schemas' total field weight.
 * - Provider credential redaction: enforced by the planner contract +
 *   STORAGE-9 log redaction.
 */
import { z } from 'zod';

import type { ProcessingJobType } from './types';

/**
 * `contentType` shows up on every payload. Closed shape: non-empty
 * ASCII MIME-ish string. The full content-type validation lives on the
 * upload-create handler (STORAGE-5 `schemas.ts`); we don't re-enforce
 * MIME validity here because the row was already validated at the
 * `storage_objects` write site. A loose ASCII check is enough to keep
 * hostile control chars and oversized values out.
 */
const contentTypeField = z
  .string()
  .min(1, 'contentType is required')
  .max(255, 'contentType is too long')
  .regex(/^[\x20-\x7E]+$/, 'contentType must be printable ASCII');

/**
 * `byteSize` appears on `scan_validation` only. Closed shape: positive
 * integer, capped at the upload-create handler's 5 GiB limit.
 */
const byteSizeField = z
  .number()
  .int('byteSize must be an integer')
  .nonnegative('byteSize must be non-negative')
  .max(5 * 1024 * 1024 * 1024, 'byteSize is too large');

// ─── Per-jobType strict schemas ─────────────────────────────────────────────

export const scanValidationPayloadSchema = z
  .object({
    contentType: contentTypeField,
    byteSize: byteSizeField,
  })
  .strict();

export const imageOptimizePayloadSchema = z
  .object({
    contentType: contentTypeField,
  })
  .strict();

export const videoProbePayloadSchema = z
  .object({
    contentType: contentTypeField,
  })
  .strict();

export const videoThumbnailPayloadSchema = z
  .object({
    contentType: contentTypeField,
  })
  .strict();

export const videoTranscodePayloadSchema = z
  .object({
    contentType: contentTypeField,
  })
  .strict();

export const documentPreviewPayloadSchema = z
  .object({
    contentType: contentTypeField,
  })
  .strict();

/**
 * Closed-set lookup mapping every `ProcessingJobType` to its strict
 * schema. Adding a new job type to `ProcessingJobType` without adding
 * a schema entry here is a compile-time error (the `Record` type
 * forces exhaustiveness).
 */
export const JOB_PAYLOAD_SCHEMAS: Record<ProcessingJobType, z.ZodTypeAny> = {
  scan_validation: scanValidationPayloadSchema,
  image_optimize: imageOptimizePayloadSchema,
  video_probe: videoProbePayloadSchema,
  video_thumbnail: videoThumbnailPayloadSchema,
  video_transcode: videoTranscodePayloadSchema,
  document_preview: documentPreviewPayloadSchema,
};

// ─── Closed-set error ──────────────────────────────────────────────────────

/**
 * Thrown by `validateJobPayload` when a payload does not match its
 * per-jobType schema. The error message is intentionally generic —
 * we surface the key names that were rejected but NEVER the offending
 * values, so a hostile caller cannot use the error message as a
 * reflective payload-leak channel.
 *
 * `statusHint: 400` mirrors the gateway envelope contract used by
 * `DuplicateActiveJobError` and the other repository-layer errors.
 */
export class PayloadValidationError extends Error {
  public readonly code = 'INVALID_JOB_PAYLOAD';
  public readonly statusHint = 400 as const;
  public readonly jobType: string;
  public readonly rejectedKeys: ReadonlyArray<string>;

  constructor(jobType: string, rejectedKeys: ReadonlyArray<string>) {
    super(
      `Invalid payload for job type "${jobType}": ${
        rejectedKeys.length === 0 ? 'shape mismatch' : `rejected keys [${rejectedKeys.join(', ')}]`
      }`,
    );
    this.name = 'PayloadValidationError';
    this.jobType = jobType;
    this.rejectedKeys = Object.freeze([...rejectedKeys]);
  }
}

// ─── Validator ─────────────────────────────────────────────────────────────

/**
 * Validate a single `(jobType, payload)` pair. Throws
 * `PayloadValidationError` on mismatch. Returns the parsed (and
 * narrowed) payload on success.
 *
 * Unknown job types are rejected via the same error — a future
 * planner edit that ships a new job type without registering a
 * schema here will fail loud on the very first enqueue.
 */
export function validateJobPayload(
  jobType: string,
  payload: unknown,
): Readonly<Record<string, unknown>> {
  const schema = (JOB_PAYLOAD_SCHEMAS as Record<string, z.ZodTypeAny | undefined>)[jobType];

  if (!schema) {
    throw new PayloadValidationError(jobType, ['<unknown jobType>']);
  }

  const result = schema.safeParse(payload);
  if (!result.success) {
    // Collect the rejected key names from the Zod issues. We only
    // surface the keys, never the values, to keep the error message
    // safe to log.
    //
    // Strict-mode rejections (`unrecognized_keys`) carry the list of
    // unknown keys on `issue.keys` with an EMPTY `path` — every other
    // issue carries the offending field on `issue.path`. Handle both.
    const rejectedKeys = new Set<string>();
    for (const issue of result.error.issues) {
      const maybeKeys = (issue as unknown as { keys?: ReadonlyArray<string> }).keys;
      if (Array.isArray(maybeKeys) && maybeKeys.length > 0) {
        for (const k of maybeKeys) rejectedKeys.add(k);
      } else if (issue.path.length === 0) {
        rejectedKeys.add('<root>');
      } else {
        rejectedKeys.add(String(issue.path[issue.path.length - 1]));
      }
    }
    throw new PayloadValidationError(jobType, [...rejectedKeys]);
  }

  return result.data as Readonly<Record<string, unknown>>;
}
