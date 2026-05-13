/**
 * Upload session lifecycle — request / response schemas.
 *
 * The gateway routes for create / complete / abort all share the action key
 * `platform.storage.objects.upload` (per STORAGE-3 route seeds). The
 * storage-service distinguishes the three lifecycle operations using a
 * payload-level `operation` discriminator. This keeps the gateway route
 * table simple (one action key per lifecycle family) while letting the
 * service enforce per-operation payload validation strictly.
 *
 * All schemas use `.strict()` so hostile callers cannot smuggle extra fields
 * through. The handlers themselves are responsible for never echoing
 * provider config / credentials back to the caller (see `responses.ts`).
 */
import { z } from 'zod';

/** Plan §7 default purpose for non-CMS callers. */
export const DEFAULT_UPLOAD_PURPOSE = 'platform_generic';

/** Allowed visibility values — mirrors `storage_objects.visibility` CHECK. */
export const UPLOAD_VISIBILITIES = ['private', 'public'] as const;

// `filename` is bounded so a hostile caller cannot wedge huge strings into
// the DB or into provider response-content-disposition headers later.
// 255 bytes is the POSIX filename ceiling; 1024 bytes is the AWS S3 key
// ceiling — `filename` is the human-readable label, not the provider key,
// so 255 is the right cap.
const filenameSchema = z
  .string()
  .min(1, 'filename is required')
  .max(255, 'filename exceeds 255 chars')
  .refine((value) => !value.includes('\0'), 'filename must not contain NUL bytes')
  .refine((value) => value === value.trim(), 'filename must not have leading/trailing whitespace');

// RFC 6838: a content type cannot have control chars or whitespace. We keep
// validation loose (the upload-side adapter and the post-upload validation
// worker will tighten this) — the goal here is just to refuse obviously
// hostile payloads (NUL bytes, CR/LF) at the front door.
const contentTypeSchema = z
  .string()
  .min(1, 'contentType is required')
  .max(255, 'contentType exceeds 255 chars')
  .refine(
    (value) => /^[\x21-\x7e]+$/.test(value),
    'contentType must be a printable ASCII media type',
  );

// `sha256` is optional; when provided, the client claims this is the SHA-256
// of the file. We store it for Xynes-side audit but never forward it to
// providers (R2 only accepts CRC-64/NVME on the wire — STORAGE-4 contract).
const sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/i, 'sha256 must be 64 lowercase hex chars')
  .transform((value) => value.toLowerCase());

const purposeSchema = z
  .string()
  .min(1, 'purpose must not be empty')
  .max(64, 'purpose exceeds 64 chars')
  .regex(/^[a-z][a-z0-9_]*$/, 'purpose must be snake_case');

/**
 * Per STORAGE-9: hard cap before we sign anything. The default sits at
 * 5 GiB so single PUTs are within the AWS S3 single-PUT ceiling; multipart
 * goes far higher. Workspaces can tighten this in the future via env or
 * provider config; the storage-service MUST always enforce a server-side
 * limit even when the caller forgets one.
 */
export const DEFAULT_MAX_BYTE_SIZE = 5 * 1024 * 1024 * 1024; // 5 GiB.

/**
 * STORAGE-5 — request schema for upload session lifecycle actions.
 *
 * The `operation` field is the discriminator; gateway routes all funnel
 * here with action key `platform.storage.objects.upload`. The
 * storage-service registers a single handler against that action key and
 * branches on `operation` internally.
 */
export const createUploadPayloadSchema = z
  .object({
    operation: z.literal('create'),
    filename: filenameSchema,
    contentType: contentTypeSchema,
    byteSize: z
      .number()
      .int('byteSize must be an integer')
      .nonnegative('byteSize must be non-negative')
      .max(DEFAULT_MAX_BYTE_SIZE, `byteSize exceeds the maximum upload size`),
    sha256: sha256Schema.optional(),
    purpose: purposeSchema.optional(),
    visibility: z.enum(UPLOAD_VISIBILITIES).optional(),
    compression: z.boolean().optional(),
  })
  .strict();

export type CreateUploadPayload = z.infer<typeof createUploadPayloadSchema>;

export const completeUploadPartSchema = z
  .object({
    partNumber: z.number().int().min(1).max(10_000),
    etag: z.string().min(1).max(256),
  })
  .strict();

export const completeUploadPayloadSchema = z
  .object({
    operation: z.literal('complete'),
    uploadId: z.string().uuid(),
    sha256: sha256Schema.optional(),
    /** Required for multipart sessions; ignored for single uploads. */
    parts: z.array(completeUploadPartSchema).max(10_000).optional(),
  })
  .strict();

export type CompleteUploadPayload = z.infer<typeof completeUploadPayloadSchema>;

export const abortUploadPayloadSchema = z
  .object({
    operation: z.literal('abort'),
    uploadId: z.string().uuid(),
  })
  .strict();

export type AbortUploadPayload = z.infer<typeof abortUploadPayloadSchema>;

/** Top-level discriminator. */
export const uploadActionPayloadSchema = z.discriminatedUnion('operation', [
  createUploadPayloadSchema,
  completeUploadPayloadSchema,
  abortUploadPayloadSchema,
]);

export type UploadActionPayload = z.infer<typeof uploadActionPayloadSchema>;
