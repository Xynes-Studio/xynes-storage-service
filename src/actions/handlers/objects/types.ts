/**
 * STORAGE-6 — repository + handler types for object metadata reads,
 * signed downloads, soft-delete, and usage aggregation.
 *
 * Storage-5 ships `StorageObjectRepository` / `UploadSessionRepository` /
 * `StorageProviderResolver`. STORAGE-6 EXTENDS the object repository
 * (find-many, soft-delete) and adds two new contracts:
 *
 *   - `StorageVariantRepository`        — listing of derived assets for an object
 *   - `StorageProcessingJobRepository`  — listing of processing jobs for an object
 *   - `StorageUsageRepository`          — read-only daily aggregate read for usage API
 *
 * Repositories surface DTOs, NOT raw DB rows. Raw rows carry
 * `provider_object_key`, `provider_id`, and `credential_ref` fields that
 * the handlers MUST NOT echo back to callers (response builders in
 * `responses.ts` strip them on the wire as well, but defense-in-depth
 * starts at the repo boundary).
 *
 * For provider resolution by NON-DEFAULT provider id (e.g. when an object
 * was created on a workspace's old provider after the default flipped),
 * STORAGE-6 adds `resolveByProviderIdForWorkspace` so a download URL or
 * delete is always issued against the SAME provider that holds the
 * original object — never the workspace's current default.
 */
import type { ProviderKind, StorageProviderAdapter } from '../../../infra/providers/types';
import type { ObjectStatus, ResolvedProvider, StorageObjectRecord } from '../uploads/types';

// Re-export the upload-side records so STORAGE-6 callers don't have to
// reach across folders.
export type {
  ObjectStatus,
  ResolvedProvider,
  StorageObjectRecord,
  Visibility,
  UploadMethod,
} from '../uploads/types';

// ── Variants (`platform.storage_object_variants`) ──────────────────────────

export type VariantStatus = 'pending' | 'ready' | 'failed';

export interface StorageObjectVariantRecord {
  readonly id: string;
  readonly objectId: string;
  readonly variantKey: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly status: VariantStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

// ── Processing jobs (`platform.storage_processing_jobs`) ───────────────────

export type ProcessingJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface StorageProcessingJobRecord {
  readonly id: string;
  readonly objectId: string;
  readonly jobType: string;
  readonly status: ProcessingJobStatus;
  readonly attempts: number;
  readonly errorCode: string | null;
  readonly scheduledAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /**
   * Added by STORAGE-7. Required jobs (e.g. scan/validation, video probe)
   * gate the parent object's aggregate status — a terminal failure on a
   * required job flips the parent to `failed`. Non-required jobs
   * (best-effort variants — thumbnails, transcodes, document previews)
   * never block `ready` and never flip the parent to `failed`.
   *
   * Production repositories that persist this column MUST default it to
   * `true` at the DB layer (fail-closed posture) so a non-migrated row
   * surfaces as required. The TS type is intentionally non-optional so
   * every caller has to make a deliberate decision per job.
   */
  readonly required: boolean;
}

// ── Usage aggregates (`platform.storage_usage_daily`) ──────────────────────

export interface StorageUsageDailyRecord {
  /** YYYY-MM-DD (UTC). */
  readonly date: string;
  readonly bytesStored: number;
  readonly bytesEgress: number;
  readonly classAOperations: number;
  readonly classBOperations: number;
  /** Per-row provider hint (NEVER returned to callers; redacted at response). */
  readonly providerKind: ProviderKind | null;
}

// ── List filters (matches `schemas.ListObjectsFilters` shape) ──────────────

export interface ListObjectsRepoFilters {
  readonly purpose?: string;
  readonly status?: ObjectStatus;
  readonly contentTypeFamily?:
    | 'image'
    | 'video'
    | 'audio'
    | 'document'
    | 'archive'
    | 'text'
    | 'other';
  readonly createdBy?: string;
  readonly createdAfter?: Date;
  readonly createdBefore?: Date;
}

export interface ListObjectsRepoInput {
  readonly workspaceId: string;
  readonly filters: ListObjectsRepoFilters;
  readonly limit: number;
  /** Opaque cursor minted by a previous call; implementations decode + verify. */
  readonly cursor: string | null;
}

export interface ListObjectsRepoResult {
  readonly items: ReadonlyArray<StorageObjectRecord>;
  /** Opaque cursor for the next page, or `null` when there is no next page. */
  readonly nextCursor: string | null;
}

// ── Extended repository contracts ─────────────────────────────────────────

export interface ExtendedStorageObjectRepository {
  findByIdForWorkspace(input: {
    objectId: string;
    workspaceId: string;
  }): Promise<StorageObjectRecord | null>;

  /**
   * Paginated workspace list. Implementations MUST exclude rows with
   * `status = 'deleted'` from results — STORAGE-6 deliberately hides
   * tombstones from the public surface.
   */
  listForWorkspace(input: ListObjectsRepoInput): Promise<ListObjectsRepoResult>;

  /**
   * Soft-delete: flips `status -> 'deleted'`, stamps `deleted_at`, and
   * leaves the row in place for audit. Returns `null` when the row does
   * not exist, is owned by a different workspace, or is already
   * `deleted` (idempotent — repeat calls return the soft-deleted row).
   *
   * Concrete contract:
   *   - rows in `pending_upload` / `uploaded` / `processing` / `ready` /
   *     `failed` -> transition to `deleted`
   *   - rows already in `deleted` -> return current row (idempotent)
   */
  softDeleteForWorkspace(input: {
    objectId: string;
    workspaceId: string;
    now: Date;
  }): Promise<StorageObjectRecord | null>;
}

export interface StorageVariantRepository {
  listForObject(input: {
    objectId: string;
    workspaceId: string;
  }): Promise<ReadonlyArray<StorageObjectVariantRecord>>;
}

export interface StorageProcessingJobRepository {
  listForObject(input: {
    objectId: string;
    workspaceId: string;
  }): Promise<ReadonlyArray<StorageProcessingJobRecord>>;
}

export interface StorageUsageRepository {
  /**
   * Reads pre-aggregated daily rows from `platform.storage_usage_daily`.
   * MUST NOT scan `storage_objects` for live totals at request time —
   * the daily aggregation job is the single producer of these rows.
   */
  readDailyForWorkspace(input: {
    workspaceId: string;
    /** Inclusive YYYY-MM-DD. */
    fromDate: string;
    /** Inclusive YYYY-MM-DD. */
    toDate: string;
  }): Promise<ReadonlyArray<StorageUsageDailyRecord>>;
}

// ── Provider resolver — extended for "resolve by provider id" ──────────────

export interface ExtendedStorageProviderResolver {
  resolveDefaultForWorkspace(workspaceId: string): Promise<ResolvedProvider | null>;
  /**
   * Resolve a specific provider id for the workspace. This is used by the
   * download-URL + delete handlers to ensure the URL is signed (or the
   * delete is issued) against the provider that actually holds the
   * original object, not whichever provider the workspace happens to
   * default to today.
   */
  resolveByProviderIdForWorkspace(input: {
    workspaceId: string;
    providerId: string;
  }): Promise<ResolvedProvider | null>;
}

// ── Aggregate handler-dependency type ─────────────────────────────────────

export interface ObjectsHandlerDependencies {
  readonly objects: ExtendedStorageObjectRepository;
  readonly variants: StorageVariantRepository;
  readonly jobs: StorageProcessingJobRepository;
  readonly usage: StorageUsageRepository;
  readonly providers: ExtendedStorageProviderResolver;
  /** Defaults to `() => new Date()`. Overridable for deterministic tests. */
  readonly now?: () => Date;
  /** Default download-URL TTL in seconds. Capped at 1 hour by the schema. */
  readonly defaultDownloadTtlSeconds?: number;
  /** Default list page size. */
  readonly defaultListLimit?: number;
}

/** Re-export adapter type so test fakes can import from a single module. */
export type { StorageProviderAdapter };
