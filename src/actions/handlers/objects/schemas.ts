/**
 * STORAGE-6 — Object metadata, signed reads, delete, and usage schemas.
 *
 * Three action keys (per STORAGE-3 route seeds + plan §7):
 *   - `platform.storage.objects.read`   → ops: `list`, `get`, `download_url`
 *   - `platform.storage.objects.delete` → op:  `delete`
 *   - `platform.storage.usage.read`     → op:  `usage`
 *
 * Each action key gets one handler that branches on a payload-level
 * `operation` discriminator — same posture as the upload lifecycle handler
 * registered in STORAGE-5.
 *
 * Every schema uses `.strict()` so hostile callers cannot smuggle extra
 * fields through. The handlers themselves are responsible for never
 * echoing provider config / credentials back to the caller
 * (see `responses.ts`).
 */
import { z } from 'zod';

// ── List objects ───────────────────────────────────────────────────────────

/**
 * Content type families used for the `contentTypeFamily` list filter.
 * Mapping from MIME type to family is handled inside the handler — the
 * caller asks for a family, not a raw MIME-prefix substring, so a hostile
 * caller cannot inject regex-like content.
 */
export const CONTENT_TYPE_FAMILIES = [
  'image',
  'video',
  'audio',
  'document',
  'archive',
  'text',
  'other',
] as const;

export type ContentTypeFamily = (typeof CONTENT_TYPE_FAMILIES)[number];

/**
 * Object status values from `platform.storage_objects.status` (mirrors
 * the CHECK constraint added by the STORAGE-2 migration).
 *
 * Note: `'deleted'` is deliberately ABSENT from the public filter set.
 * The list endpoint NEVER returns soft-deleted rows; allowing callers to
 * filter for them would leak deletion timing.
 */
export const PUBLIC_OBJECT_STATUSES = [
  'pending_upload',
  'uploaded',
  'processing',
  'ready',
  'failed',
] as const;

/** Default list page size. */
export const DEFAULT_LIST_LIMIT = 50;
/** Hard cap on list page size — bounds memory and provider-call cost. */
export const MAX_LIST_LIMIT = 200;

const optionalIsoDate = z
  .string()
  .datetime({ offset: true, message: 'must be an ISO-8601 timestamp' })
  .optional();

const listFiltersSchema = z
  .object({
    /** Filter by `storage_objects.purpose`. */
    purpose: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_]*$/)
      .optional(),
    /** Filter by object status (one of `PUBLIC_OBJECT_STATUSES`). */
    status: z.enum(PUBLIC_OBJECT_STATUSES).optional(),
    /** Coarse-grained content-type family — never a raw MIME pattern. */
    contentTypeFamily: z.enum(CONTENT_TYPE_FAMILIES).optional(),
    /** Filter by owner / creator user id. */
    createdBy: z.string().uuid().optional(),
    /** Created at or after this ISO timestamp. */
    createdAfter: optionalIsoDate,
    /** Created at or before this ISO timestamp. */
    createdBefore: optionalIsoDate,
  })
  .strict();

export type ListObjectsFilters = z.infer<typeof listFiltersSchema>;

export const listObjectsPayloadSchema = z
  .object({
    operation: z.literal('list'),
    filters: listFiltersSchema.optional(),
    limit: z.number().int().min(1).max(MAX_LIST_LIMIT).optional(),
    /** Opaque cursor minted by the previous list response (or `null` / undefined). */
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();

export type ListObjectsPayload = z.infer<typeof listObjectsPayloadSchema>;

// ── Get one object ─────────────────────────────────────────────────────────

export const getObjectPayloadSchema = z
  .object({
    operation: z.literal('get'),
    objectId: z.string().uuid(),
  })
  .strict();

export type GetObjectPayload = z.infer<typeof getObjectPayloadSchema>;

// ── Create download URL ───────────────────────────────────────────────────

/**
 * Default download-URL expiry (15 min). Capped by the adapter to the SigV4
 * 7-day hard ceiling; we deliberately use a much shorter default so
 * leaked URLs have a small blast radius.
 */
export const DEFAULT_DOWNLOAD_URL_TTL_SECONDS = 15 * 60;
export const MIN_DOWNLOAD_URL_TTL_SECONDS = 30;
export const MAX_DOWNLOAD_URL_TTL_SECONDS = 60 * 60; // 1 hour ceiling for STORAGE-6.

/**
 * `downloadFilename` is optional. When supplied, the adapter will pass it
 * through to `ResponseContentDisposition` so the browser names the
 * downloaded file accordingly. The adapter is responsible for stripping
 * CRLF / quote characters (header-injection guard, STORAGE-4 contract).
 */
const downloadFilenameSchema = z
  .string()
  .min(1, 'downloadFilename must not be empty')
  .max(255, 'downloadFilename exceeds 255 chars')
  .refine((value) => !/[\r\n"]/.test(value), 'downloadFilename must not contain CR/LF/quote chars');

export const createDownloadUrlPayloadSchema = z
  .object({
    operation: z.literal('download_url'),
    objectId: z.string().uuid(),
    expiresInSeconds: z
      .number()
      .int()
      .min(MIN_DOWNLOAD_URL_TTL_SECONDS)
      .max(MAX_DOWNLOAD_URL_TTL_SECONDS)
      .optional(),
    downloadFilename: downloadFilenameSchema.optional(),
  })
  .strict();

export type CreateDownloadUrlPayload = z.infer<typeof createDownloadUrlPayloadSchema>;

// ── Delete object ──────────────────────────────────────────────────────────

export const deleteObjectPayloadSchema = z
  .object({
    operation: z.literal('delete'),
    objectId: z.string().uuid(),
  })
  .strict();

export type DeleteObjectPayload = z.infer<typeof deleteObjectPayloadSchema>;

// ── Usage read ─────────────────────────────────────────────────────────────

/** Hard cap on the usage date-range span to bound aggregation cost. */
export const MAX_USAGE_RANGE_DAYS = 366;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD');

export const usageReadPayloadSchema = z
  .object({
    operation: z.literal('usage'),
    /** Inclusive start date (YYYY-MM-DD). Defaults to (today - 29 days). */
    from: isoDate.optional(),
    /** Inclusive end date (YYYY-MM-DD). Defaults to today (UTC). */
    to: isoDate.optional(),
  })
  .strict();

export type UsageReadPayload = z.infer<typeof usageReadPayloadSchema>;

// ── Discriminated unions per action key ────────────────────────────────────

/** Payloads on the `platform.storage.objects.read` action key. */
export const objectsReadPayloadSchema = z.discriminatedUnion('operation', [
  listObjectsPayloadSchema,
  getObjectPayloadSchema,
  createDownloadUrlPayloadSchema,
]);

export type ObjectsReadPayload = z.infer<typeof objectsReadPayloadSchema>;

/** Payloads on the `platform.storage.objects.delete` action key. */
export const objectsDeletePayloadSchema = deleteObjectPayloadSchema;

/** Payloads on the `platform.storage.usage.read` action key. */
export const usageReadActionPayloadSchema = usageReadPayloadSchema;

/**
 * Coarse classifier from MIME -> family. Kept in this module so handlers
 * and tests share the canonical mapping.
 *
 * Unknown / malformed MIME types fall through to `'other'`. Note that the
 * caller-supplied `contentType` is bound-checked in upload schemas; this
 * function never rejects (it's a classifier, not a validator).
 */
export function classifyContentType(contentType: string): ContentTypeFamily {
  if (typeof contentType !== 'string' || contentType.length === 0) return 'other';
  const lower = contentType.toLowerCase();
  if (lower.startsWith('image/')) return 'image';
  if (lower.startsWith('video/')) return 'video';
  if (lower.startsWith('audio/')) return 'audio';
  if (lower.startsWith('text/')) return 'text';
  if (
    lower === 'application/pdf' ||
    lower.startsWith('application/vnd.openxmlformats-officedocument.') ||
    lower.startsWith('application/vnd.oasis.opendocument.') ||
    lower === 'application/msword' ||
    lower === 'application/vnd.ms-excel' ||
    lower === 'application/vnd.ms-powerpoint' ||
    lower === 'application/rtf'
  ) {
    return 'document';
  }
  if (
    lower === 'application/zip' ||
    lower === 'application/x-tar' ||
    lower === 'application/x-7z-compressed' ||
    lower === 'application/x-rar-compressed' ||
    lower === 'application/gzip' ||
    lower === 'application/x-bzip2'
  ) {
    return 'archive';
  }
  return 'other';
}
