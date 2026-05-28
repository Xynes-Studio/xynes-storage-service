/**
 * STORAGE-6 — public response DTOs.
 *
 * Every wire DTO here is an explicit field allowlist — NO `provider_kind`,
 * `endpoint`, `region`, `bucket`, `provider_object_key`, `credential_ref`,
 * `accessKeyId`, `secretAccessKey`, or presigned-URL signature parameter
 * appears at the top level. Inherits the same posture STORAGE-5 enforces
 * for the upload session response builders.
 *
 * The signed `url` string inside `CreateDownloadUrlResponse` embeds the
 * signature opaquely — that is by design (the caller treats it as a
 * black-box bearer token).
 *
 * The list endpoint MUST NEVER return rows with `status = 'deleted'` —
 * defense-in-depth on top of the repository's own filtering.
 */
import { toPublicObject } from '../uploads/responses';
import type { PublicStorageObject } from '../uploads/responses';
import type {
  StorageObjectRecord,
  StorageObjectVariantRecord,
  StorageProcessingJobRecord,
  StorageUsageDailyRecord,
} from './types';

export type { PublicStorageObject };
export { toPublicObject };

// ── Variant DTO ───────────────────────────────────────────────────────────

export interface PublicStorageVariant {
  readonly id: string;
  readonly objectId: string;
  readonly variantKey: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toPublicVariant(row: StorageObjectVariantRecord): PublicStorageVariant {
  return {
    id: row.id,
    objectId: row.objectId,
    variantKey: row.variantKey,
    contentType: row.contentType,
    byteSize: row.byteSize,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ── Processing job DTO ────────────────────────────────────────────────────

export interface PublicProcessingJob {
  readonly id: string;
  readonly objectId: string;
  readonly jobType: string;
  readonly status: string;
  readonly attempts: number;
  readonly errorCode: string | null;
  readonly required: boolean;
  readonly scheduledAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toPublicProcessingJob(row: StorageProcessingJobRecord): PublicProcessingJob {
  return {
    id: row.id,
    objectId: row.objectId,
    jobType: row.jobType,
    status: row.status,
    attempts: row.attempts,
    errorCode: row.errorCode,
    required: row.required,
    scheduledAt: row.scheduledAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ── List objects response ─────────────────────────────────────────────────

export interface ListObjectsResponse {
  readonly items: ReadonlyArray<PublicStorageObject>;
  readonly nextCursor: string | null;
}

/**
 * Build the list response. Defensive: filters out any row that slipped
 * through with `status = 'deleted'` (the repo should never return them,
 * but we never trust upstream data).
 */
export function toListObjectsResponse(
  items: ReadonlyArray<StorageObjectRecord>,
  nextCursor: string | null,
): ListObjectsResponse {
  return {
    items: items.filter((row) => row.status !== 'deleted').map(toPublicObject),
    nextCursor,
  };
}

// ── Get object response ───────────────────────────────────────────────────

export interface GetObjectResponse {
  readonly object: PublicStorageObject;
  readonly variants: ReadonlyArray<PublicStorageVariant>;
  readonly processingJobs: ReadonlyArray<PublicProcessingJob>;
}

export function toGetObjectResponse(
  object: StorageObjectRecord,
  variants: ReadonlyArray<StorageObjectVariantRecord>,
  jobs: ReadonlyArray<StorageProcessingJobRecord>,
): GetObjectResponse {
  return {
    object: toPublicObject(object),
    variants: variants.map(toPublicVariant),
    processingJobs: jobs.map(toPublicProcessingJob),
  };
}

// ── Create download URL response ──────────────────────────────────────────

/**
 * Plan §7.1: download-URL response carries `{ objectId, url, expiresAt }`
 * and nothing else.
 */
export interface CreateDownloadUrlResponse {
  readonly objectId: string;
  readonly url: string;
  readonly expiresAt: string;
}

// ── Delete object response ────────────────────────────────────────────────

export interface DeleteObjectResponse {
  readonly object: PublicStorageObject;
  /**
   * DEDUP-2 — when present, the delete handler did NOT soft-delete the
   * object because other references still hold it. The caller removed
   * THEIR reference (via the `ownerKind`/`ownerId` payload pair) but
   * the underlying bytes are still in use by `referencesRemaining`
   * other consumers.
   *
   * Omitted on the legacy STORAGE-6 force-soft-delete path (no
   * `ownerKind`/`ownerId` supplied) and on the "last reference removed"
   * path where the object IS soft-deleted. Pre-DEDUP-2 callers that
   * don't read this field continue to work — they see the soft-deleted
   * object DTO as before.
   */
  readonly referencesRemaining?: number;
}

// ── Usage read response ───────────────────────────────────────────────────

/**
 * Daily usage row. Per-day, NOT per-provider — the response collapses
 * per-provider rows for the same date so callers never see `providerKind`.
 */
export interface PublicUsageDailyEntry {
  readonly date: string;
  readonly bytesStored: number;
  readonly bytesEgress: number;
  readonly classAOperations: number;
  readonly classBOperations: number;
}

export interface UsageTotals {
  readonly bytesStored: number;
  readonly bytesEgress: number;
  readonly classAOperations: number;
  readonly classBOperations: number;
}

export interface UsageReadResponse {
  readonly from: string;
  readonly to: string;
  readonly daily: ReadonlyArray<PublicUsageDailyEntry>;
  readonly totals: UsageTotals;
}

/**
 * Collapse per-provider daily rows into one entry per date. We pick the
 * "last" row for `bytesStored` because the daily aggregation job stamps
 * the row with the end-of-day storage snapshot; egress / ops are summed
 * across providers.
 *
 * Defensive: filters out rows whose `date` is outside `[from, to]` even
 * though the repo SHOULD already do so.
 */
export function toUsageReadResponse(
  rows: ReadonlyArray<StorageUsageDailyRecord>,
  from: string,
  to: string,
): UsageReadResponse {
  const inRange = rows.filter((r) => r.date >= from && r.date <= to);
  const byDate = new Map<
    string,
    { bytesStored: number; bytesEgress: number; classA: number; classB: number }
  >();
  for (const row of inRange) {
    const cur = byDate.get(row.date) ?? {
      bytesStored: 0,
      bytesEgress: 0,
      classA: 0,
      classB: 0,
    };
    // Sum across providers for ops + egress; for bytesStored we take the
    // max so per-day snapshots stay sane across multi-provider workspaces.
    byDate.set(row.date, {
      bytesStored: Math.max(cur.bytesStored, row.bytesStored),
      bytesEgress: cur.bytesEgress + row.bytesEgress,
      classA: cur.classA + row.classAOperations,
      classB: cur.classB + row.classBOperations,
    });
  }
  const daily: PublicUsageDailyEntry[] = [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, v]) => ({
      date,
      bytesStored: v.bytesStored,
      bytesEgress: v.bytesEgress,
      classAOperations: v.classA,
      classBOperations: v.classB,
    }));
  const totals: UsageTotals = daily.reduce(
    (acc, d) => ({
      // Storage totals are summed across days (operator-friendly): caller can
      // average / pick max client-side; we expose a stable aggregate.
      bytesStored: acc.bytesStored + d.bytesStored,
      bytesEgress: acc.bytesEgress + d.bytesEgress,
      classAOperations: acc.classAOperations + d.classAOperations,
      classBOperations: acc.classBOperations + d.classBOperations,
    }),
    { bytesStored: 0, bytesEgress: 0, classAOperations: 0, classBOperations: 0 },
  );
  return { from, to, daily, totals };
}
