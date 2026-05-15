/**
 * STORAGE-FU-2 — barrel export for the production Drizzle repositories.
 *
 * STORAGE-FU-4 (composition root) imports from this barrel; tests can
 * import either from here or from the individual files.
 *
 * The seven contracts implemented by this folder map onto:
 *   - STORAGE-5 — `StorageObjectRepository`, `UploadSessionRepository`
 *   - STORAGE-6 — `ExtendedStorageObjectRepository`,
 *                 `StorageVariantRepository`,
 *                 `StorageProcessingJobRepository`,
 *                 `StorageUsageRepository`
 *   - STORAGE-7 — `ProcessingJobQueueRepository`,
 *                 `StorageObjectStatusRepository`
 *   - STORAGE-9 — `AbandonedUploadSessionRepository`
 *
 * Provider resolver (`StorageProviderResolver` /
 * `ExtendedStorageProviderResolver`) is OUT OF SCOPE for STORAGE-FU-2;
 * it lands in STORAGE-FU-3 alongside the secret-manager interface.
 */
export {
  PostgresStorageObjectRepository,
  PostgresExtendedStorageObjectRepository,
  PostgresUploadSessionRepository,
  PostgresAbandonedUploadSessionRepository,
  PostgresStorageObjectStatusRepository,
} from './object-and-session-repository';
export {
  PostgresStorageVariantRepository,
  PostgresStorageProcessingJobRepository,
  PostgresProcessingJobQueueRepository,
  PostgresStorageUsageRepository,
} from './variant-job-usage-repository';
export {
  deriveJobRequired,
  mapStorageObjectRow,
  mapUploadSessionRow,
  mapVariantRow,
  mapProcessingJobRow,
  mapUsageRow,
  type UsageRowWithProviderKind,
} from './mappers';
