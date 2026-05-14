/**
 * STORAGE-7 — retry action payload schema.
 *
 * Action key: `platform.storage.objects.process.retry` (per STORAGE-3
 * route seeds). The gateway forwards a single `POST` route here; the
 * service distinguishes the operation via the `operation` discriminator
 * (same posture as STORAGE-5/STORAGE-6 dispatchers).
 *
 * The retry handler accepts:
 *   - `operation: 'retry'`
 *   - `objectId: <UUID>` — the object whose terminally-failed processing
 *     jobs should be requeued.
 *
 * The handler MUST NOT accept a list of `jobId`s — that would let a
 * caller pin a single job back to `queued` without re-evaluating the
 * aggregate; retry policy lives at the object level.
 */
import { z } from 'zod';

export const retryProcessingPayloadSchema = z
  .object({
    operation: z.literal('retry'),
    objectId: z.string().uuid(),
  })
  .strict();

export type RetryProcessingPayload = z.infer<typeof retryProcessingPayloadSchema>;

export const processingActionPayloadSchema = z.discriminatedUnion('operation', [
  retryProcessingPayloadSchema,
]);

export type ProcessingActionPayload = z.infer<typeof processingActionPayloadSchema>;
