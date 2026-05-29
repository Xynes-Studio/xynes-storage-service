/**
 * STORAGE-FU-2 — shared row-to-DTO mappers for the Drizzle repositories.
 *
 * The DB schema column names diverge from the public DTO field names in
 * a few places (acceptable: the DB is owned by `xynes-infra`, the DTOs
 * are owned by the handler contracts). This module concentrates every
 * mapping in one place so:
 *
 *   - the divergence is documented once,
 *   - the mappers can be unit-tested without touching Postgres, and
 *   - repositories never spread raw rows (defense in depth on top of
 *     STORAGE-6's response builders).
 *
 * Field divergence highlights:
 *   - `storage_object_variants.variant_kind` → DTO `variantKey`
 *   - `storage_object_variants.duration_ms` → DTO `durationSeconds`
 *     (not yet projected — the variant DTO does NOT expose duration).
 *   - `storage_processing_jobs.job_kind` → DTO `jobType`
 *   - `storage_processing_jobs.started_at`/`finished_at` → derived
 *     `updatedAt` (we use `finished_at ?? started_at ?? created_at`).
 *   - `storage_processing_jobs.required` is now a real column as of
 *     STORAGE-FU-2-FU-2 — the mapper reads it straight off the row.
 *     The previous TS-side `REQUIRED_BY_JOB_TYPE` derivation table was
 *     removed in the same change set.
 *   - `storage_processing_jobs.payload` is now a real column as of
 *     STORAGE-FU-2-FU-2 — the queue repository projects it directly
 *     into `ClaimedJob.payload`. The mapper does not include `payload`
 *     in `StorageProcessingJobRecord` because that DTO is the public
 *     surface and STORAGE-6 deliberately keeps payload off the wire.
 *
 * Security invariants enforced here:
 *   - Mappers NEVER spread row objects. Every DTO field is assigned
 *     explicitly so a column added to the DB cannot bleed through.
 *   - `provider_object_key`, `credential_ref`, `endpoint`, `bucket`,
 *     `region` are NEVER mapped into any of the public DTOs. They live
 *     on the workspace-provider row, which is consumed by the provider
 *     resolver, not by the object DTO.
 *   - `payload` is intentionally NOT mapped into
 *     `StorageProcessingJobRecord` — the queue repo projects it onto
 *     `ClaimedJob.payload` only, where it reaches the runner via the
 *     STORAGE-8 `JobRunnerContext`. The STORAGE-6 GET-object handler
 *     consumes `StorageProcessingJobRecord` and keeps payload off the
 *     wire by construction.
 */
import type {
  StorageObjectRow,
  StorageUploadSessionRow,
  StorageObjectVariantRow,
  StorageProcessingJobRow,
  StorageUsageDailyRow,
} from '../schema';
import type {
  StorageObjectRecord,
  UploadSessionRecord,
} from '../../../actions/handlers/uploads/types';
import type {
  StorageObjectVariantRecord,
  StorageProcessingJobRecord,
  StorageUsageDailyRecord,
  VariantStatus,
} from '../../../actions/handlers/objects/types';
import type { ProcessingJobType } from '../../../actions/handlers/processing/types';

// ── platform.storage_objects → StorageObjectRecord ─────────────────────────

export function mapStorageObjectRow(row: StorageObjectRow): StorageObjectRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    providerId: row.providerId,
    providerObjectKey: row.providerObjectKey,
    filename: row.filename,
    contentType: row.contentType,
    byteSize: Number(row.byteSize),
    sha256: row.sha256,
    purpose: row.purpose,
    visibility: row.visibility,
    status: row.status,
    compressionRequested: row.compressionRequested,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    uploadedAt: row.uploadedAt,
  };
}

// ── platform.storage_upload_sessions → UploadSessionRecord ─────────────────

export function mapUploadSessionRow(row: StorageUploadSessionRow): UploadSessionRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    objectId: row.objectId,
    uploadMethod: row.uploadMethod,
    providerUploadId: row.providerUploadId,
    status: row.status,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    completedAt: row.completedAt,
    abortedAt: row.abortedAt,
    createdBy: row.createdBy,
  };
}

// ── platform.storage_object_variants → StorageObjectVariantRecord ──────────

export function mapVariantRow(row: StorageObjectVariantRow): StorageObjectVariantRecord {
  return {
    id: row.id,
    objectId: row.objectId,
    // DB column: variant_kind. DTO field: variantKey. The two names
    // mean the same thing in the storage contract.
    variantKey: row.variantKind,
    contentType: row.contentType,
    byteSize: Number(row.byteSize),
    status: row.status as VariantStatus,
    createdAt: row.createdAt,
    // `storage_object_variants` has no `updated_at`. Derive: use
    // `ready_at` when present, else `created_at`. This preserves the
    // "updated when transitioned" semantic the DTO consumers expect.
    updatedAt: row.readyAt ?? row.createdAt,
  };
}

// ── platform.storage_processing_jobs → StorageProcessingJobRecord ──────────

export function mapProcessingJobRow(row: StorageProcessingJobRow): StorageProcessingJobRecord {
  return {
    id: row.id,
    objectId: row.objectId,
    // DB column: job_kind. DTO field: jobType. STORAGE-7 planner uses
    // the closed `ProcessingJobType` enum; we cast knowing the planner
    // is the only writer to this column. The worker treats an unknown
    // job type as a missing-runner failure, which is the same behaviour
    // a typo would cause anyway.
    jobType: row.jobKind as ProcessingJobType,
    status: row.status,
    attempts: row.attempts,
    errorCode: row.errorCode,
    scheduledAt: row.scheduledAt,
    createdAt: row.createdAt,
    // No `updated_at` column on the table. Derive from the lifecycle
    // timestamps: finished_at ?? started_at ?? created_at.
    updatedAt: row.finishedAt ?? row.startedAt ?? row.createdAt,
    // STORAGE-FU-2-FU-2: `required` is now a real column on
    // `platform.storage_processing_jobs` (NOT NULL DEFAULT true,
    // fail-closed). The previous `REQUIRED_BY_JOB_TYPE` TS-side
    // derivation table was removed in the same change set. The
    // canonical migration's backfill populated this column for every
    // pre-FU-2-FU-2 row.
    required: row.required,
  };
}

// ── platform.storage_usage_daily → StorageUsageDailyRecord ─────────────────

export interface UsageRowWithProviderKind extends StorageUsageDailyRow {
  /**
   * The repository joins `workspace_storage_providers.provider_kind`
   * onto each row so the aggregator can identify the provider for cost
   * attribution. The kind is then redacted from the wire DTO by the
   * STORAGE-6 response builder.
   */
  readonly providerKind: string | null;
}

export function mapUsageRow(row: UsageRowWithProviderKind): StorageUsageDailyRecord {
  return {
    date: typeof row.usageDate === 'string' ? row.usageDate : String(row.usageDate),
    bytesStored: Number(row.bytesStored),
    bytesEgress: Number(row.bytesEgress),
    classAOperations: Number(row.operationsClassA),
    classBOperations: Number(row.operationsClassB),
    // Cast: the kind set on the wire is enforced by the canonical
    // migration's CHECK constraint, so any value coming from the DB
    // must be one of the closed-set kinds.
    providerKind: (row.providerKind ?? null) as StorageUsageDailyRecord['providerKind'],
  };
}
