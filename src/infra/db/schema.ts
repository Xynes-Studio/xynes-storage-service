/**
 * Drizzle schema mirror for the `platform.storage_*` tables.
 *
 * SOURCE OF TRUTH:
 *   xynes/xynes-infra/supabase/migrations/20260513090000_universal_storage_platform_schema.sql
 *
 * This file is a READ-ONLY MIRROR. `xynes-storage-service` does NOT own the
 * schema and does NOT ship migrations. Adding a column / changing a CHECK
 * / adding an index must happen in the canonical Supabase migration above
 * FIRST, then the mirror is updated to match.
 *
 * SECURITY INVARIANTS (enforced by `tests/infra/db/schema.test.ts`):
 *   1. No raw provider credential columns. `credential_ref` is the only
 *      column that touches credentials, and it stores a REFERENCE
 *      (secret-manager key / env alias) — never a raw key, secret, R2
 *      token, or signed URL. Forbidden column names that MUST NOT appear:
 *      `provider_credentials`, `raw_key`, `secret_access_key`, `r2_token`,
 *      `signed_url`, `presigned_url`, `access_key_id`.
 *   2. Every status / kind / visibility / method enum below matches the
 *      `IN (...)` allowlist in the canonical migration byte-for-byte.
 *   3. `provider_object_key` lives ONLY on `storage_objects` /
 *      `storage_object_variants`. Apps persist `id` only.
 *
 * Status / visibility / method values are typed as union literals — Drizzle
 * `text()` columns carry the closed-set type via the `.$type<...>()` brand,
 * so callers cannot accidentally write `status: 'archived'` against a
 * `storage_objects` row.
 */
import {
  pgSchema,
  bigint,
  boolean,
  date,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

// ─── Schemas ────────────────────────────────────────────────────────────────
// The mirror declares the schemas it touches; FK target tables in `identity`
// + `platform` are referenced by name only (we do not own those tables).
export const platformSchema = pgSchema('platform');
export const identitySchema = pgSchema('identity');

// ─── FK referents (declared for type-safety; owned by other migrations) ─────
// These tables exist already in the database (created by
// xynes-infra Supabase migrations). We declare a minimal Drizzle handle so
// foreign-key references type-check; we never read or write them from this
// service.
export const workspaces = platformSchema.table('workspaces', {
  id: uuid('id').primaryKey(),
});

export const users = identitySchema.table('users', {
  id: uuid('id').primaryKey(),
});

// ─── Closed-set type unions (mirror the migration CHECK constraints) ────────

/** Plan §9 `workspace_storage_providers.provider_kind` allowlist. */
export const STORAGE_PROVIDER_KINDS = ['r2', 'minio', 's3_compatible'] as const;
export type StorageProviderKind = (typeof STORAGE_PROVIDER_KINDS)[number];

/** Plan §9 `workspace_storage_providers.status` allowlist. */
export const STORAGE_PROVIDER_STATUSES = ['active', 'disabled'] as const;
export type StorageProviderStatus = (typeof STORAGE_PROVIDER_STATUSES)[number];

/** Plan §9 `storage_objects.status` state-machine values. */
export const STORAGE_OBJECT_STATUSES = [
  'pending_upload',
  'uploaded',
  'processing',
  'ready',
  'failed',
  'deleted',
] as const;
export type StorageObjectStatus = (typeof STORAGE_OBJECT_STATUSES)[number];

/** Plan §9 `storage_objects.visibility` allowlist. */
export const STORAGE_OBJECT_VISIBILITIES = ['private', 'public'] as const;
export type StorageObjectVisibility = (typeof STORAGE_OBJECT_VISIBILITIES)[number];

/** Plan §9 `storage_upload_sessions.upload_method` allowlist. */
export const UPLOAD_SESSION_METHODS = ['single', 'multipart'] as const;
export type UploadSessionMethod = (typeof UPLOAD_SESSION_METHODS)[number];

/** Plan §9 `storage_upload_sessions.status` state-machine values. */
export const UPLOAD_SESSION_STATUSES = ['pending', 'completed', 'aborted', 'expired'] as const;
export type UploadSessionStatus = (typeof UPLOAD_SESSION_STATUSES)[number];

/** Plan §9 `storage_object_variants.status` state-machine values. */
export const STORAGE_VARIANT_STATUSES = ['pending', 'ready', 'failed'] as const;
export type StorageVariantStatus = (typeof STORAGE_VARIANT_STATUSES)[number];

/** Plan §9 `storage_processing_jobs.status` state-machine values. */
export const PROCESSING_JOB_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type ProcessingJobStatus = (typeof PROCESSING_JOB_STATUSES)[number];

/**
 * DEDUP-1 `storage_object_references.owner_kind` closed-set values.
 *
 * Mirrors the CHECK constraint in the canonical migration
 * `20260528090000_storage_object_references_and_dedup_index.sql`.
 *
 * Adding a new owner kind requires (1) an additive Supabase migration
 * that ALTERs the CHECK constraint, (2) updating this tuple in lockstep,
 * (3) updating the `db-check` drift detector, and (4) updating the
 * upstream handler that mints references of the new kind.
 */
export const STORAGE_OBJECT_REFERENCE_OWNER_KINDS = [
  'cms_entry',
  'comment',
  'doc_service',
  'user_avatar',
  'workspace_logo',
  'platform_generic',
] as const;
export type StorageObjectReferenceOwnerKind = (typeof STORAGE_OBJECT_REFERENCE_OWNER_KINDS)[number];

// ─── platform.workspace_storage_providers ───────────────────────────────────
// Stores credential REFERENCES only — see column comment in the canonical
// migration. NEVER raw access keys, secret keys, R2 tokens, or signed URLs.
export const workspaceStorageProviders = platformSchema.table('workspace_storage_providers', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  providerKind: text('provider_kind').$type<StorageProviderKind>().notNull(),
  displayName: text('display_name').notNull(),
  bucket: text('bucket').notNull(),
  region: text('region'),
  endpoint: text('endpoint'),
  credentialRef: text('credential_ref').notNull(),
  status: text('status').$type<StorageProviderStatus>().notNull().default('active'),
  isDefault: boolean('is_default').notNull().default(false),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── platform.storage_objects ───────────────────────────────────────────────
// Canonical metadata for every uploaded object. `provider_object_key` is
// the provider-side key; apps must persist `id` only.
export const storageObjects = platformSchema.table('storage_objects', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  providerId: uuid('provider_id')
    .notNull()
    .references(() => workspaceStorageProviders.id),
  providerObjectKey: text('provider_object_key').notNull(),
  filename: text('filename').notNull(),
  contentType: text('content_type').notNull(),
  byteSize: bigint('byte_size', { mode: 'bigint' }).notNull(),
  sha256: text('sha256'),
  purpose: text('purpose').notNull().default('platform_generic'),
  visibility: text('visibility').$type<StorageObjectVisibility>().notNull().default('private'),
  status: text('status').$type<StorageObjectStatus>().notNull().default('pending_upload'),
  compressionRequested: boolean('compression_requested').notNull().default(true),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }),
  readyAt: timestamp('ready_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  failureCode: text('failure_code'),
  failureMessage: text('failure_message'),
});

// ─── platform.storage_upload_sessions ───────────────────────────────────────
export const storageUploadSessions = platformSchema.table('storage_upload_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  objectId: uuid('object_id')
    .notNull()
    .references(() => storageObjects.id, { onDelete: 'cascade' }),
  uploadMethod: text('upload_method').$type<UploadSessionMethod>().notNull(),
  providerUploadId: text('provider_upload_id'),
  status: text('status').$type<UploadSessionStatus>().notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  abortedAt: timestamp('aborted_at', { withTimezone: true }),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
});

// ─── platform.storage_object_variants ───────────────────────────────────────
export const storageObjectVariants = platformSchema.table('storage_object_variants', {
  id: uuid('id').primaryKey().defaultRandom(),
  objectId: uuid('object_id')
    .notNull()
    .references(() => storageObjects.id, { onDelete: 'cascade' }),
  variantKind: text('variant_kind').notNull(),
  providerObjectKey: text('provider_object_key').notNull(),
  contentType: text('content_type').notNull(),
  byteSize: bigint('byte_size', { mode: 'bigint' }).notNull(),
  width: integer('width'),
  height: integer('height'),
  durationMs: integer('duration_ms'),
  status: text('status').$type<StorageVariantStatus>().notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  readyAt: timestamp('ready_at', { withTimezone: true }),
});

// ─── platform.storage_processing_jobs ───────────────────────────────────────
export const storageProcessingJobs = platformSchema.table('storage_processing_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  objectId: uuid('object_id')
    .notNull()
    .references(() => storageObjects.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  jobKind: text('job_kind').notNull(),
  status: text('status').$type<ProcessingJobStatus>().notNull().default('queued'),
  attempts: integer('attempts').notNull().default(0),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // STORAGE-FU-2-FU-2: persisted planner payload.
  // Canonical source: 20260529090000_storage_processing_jobs_payload_and_required.sql.
  // Must NEVER carry credentials, provider config, or signed URLs — the
  // planner (`src/actions/handlers/processing/planner.ts`) only emits
  // `{ contentType, byteSize? }`. Per-jobType Zod `.strict()` validators
  // in `src/actions/handlers/processing/payload-schemas.ts` enforce this
  // before INSERT.
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  // STORAGE-FU-2-FU-2: required-job flag for the STORAGE-7 aggregator.
  // Required jobs that fail terminally flip the parent object to
  // `failed`; non-required (best-effort) failures do not. Closed-set
  // discriminator via boolean. Defaults to `true` (fail-closed) so a
  // future job kind not yet wired to the planner cannot accidentally be
  // treated as best-effort and silently dead-letter.
  required: boolean('required').notNull().default(true),
});

// ─── platform.storage_usage_daily ───────────────────────────────────────────
// Pre-aggregated daily counters. STORAGE-6 usage handler reads from this
// table; live full-table scans of storage_objects are forbidden.
export const storageUsageDaily = platformSchema.table('storage_usage_daily', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  providerId: uuid('provider_id').references(() => workspaceStorageProviders.id),
  usageDate: date('usage_date').notNull(),
  bytesStored: bigint('bytes_stored', { mode: 'bigint' }).notNull().default(0n),
  bytesEgress: bigint('bytes_egress', { mode: 'bigint' }).notNull().default(0n),
  operationsClassA: bigint('operations_class_a', { mode: 'bigint' }).notNull().default(0n),
  operationsClassB: bigint('operations_class_b', { mode: 'bigint' }).notNull().default(0n),
  objectCount: bigint('object_count', { mode: 'bigint' }).notNull().default(0n),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── platform.storage_object_references (DEDUP-1) ───────────────────────────
// Reference-counting join table. One row per (object, owner_kind, owner_id)
// triple. The composite PRIMARY KEY enforces idempotency at the DB layer —
// re-inserting the same triple is a no-op via `ON CONFLICT … DO NOTHING`
// in the upstream handler.
//
// `owner_id` deliberately has NO foreign key — different owner kinds target
// different schemas (`cms.content_entries`, `cms.comments`, `docs.documents`,
// `identity.users`). Validation of the owner identity is the upstream
// handler's job.
export const storageObjectReferences = platformSchema.table(
  'storage_object_references',
  {
    objectId: uuid('object_id')
      .notNull()
      .references(() => storageObjects.id, { onDelete: 'cascade' }),
    ownerKind: text('owner_kind').$type<StorageObjectReferenceOwnerKind>().notNull(),
    ownerId: uuid('owner_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.objectId, t.ownerKind, t.ownerId] }),
  }),
);

// ─── Row types — handy for repository implementations ───────────────────────
export type WorkspaceStorageProviderRow = typeof workspaceStorageProviders.$inferSelect;
export type WorkspaceStorageProviderInsert = typeof workspaceStorageProviders.$inferInsert;

export type StorageObjectRow = typeof storageObjects.$inferSelect;
export type StorageObjectInsert = typeof storageObjects.$inferInsert;

export type StorageUploadSessionRow = typeof storageUploadSessions.$inferSelect;
export type StorageUploadSessionInsert = typeof storageUploadSessions.$inferInsert;

export type StorageObjectVariantRow = typeof storageObjectVariants.$inferSelect;
export type StorageObjectVariantInsert = typeof storageObjectVariants.$inferInsert;

export type StorageProcessingJobRow = typeof storageProcessingJobs.$inferSelect;
export type StorageProcessingJobInsert = typeof storageProcessingJobs.$inferInsert;

export type StorageUsageDailyRow = typeof storageUsageDaily.$inferSelect;
export type StorageUsageDailyInsert = typeof storageUsageDaily.$inferInsert;

export type StorageObjectReferenceRow = typeof storageObjectReferences.$inferSelect;
export type StorageObjectReferenceInsert = typeof storageObjectReferences.$inferInsert;
