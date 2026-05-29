/**
 * STORAGE-FU-5 — processors module barrel.
 *
 * Public surface:
 *   - `createS3ProviderObjectIO` — server-side `ProviderObjectIO`
 *     impl backed by the resolved `StorageProviderAdapter`.
 *   - `PostgresStorageVariantWriter` — Drizzle-backed
 *     `StorageVariantWriter` impl with original-protection.
 *   - Stub processors for local dev.
 *   - Production processor stubs (currently throw `UNSUPPORTED_FORMAT`
 *     until the follow-up infra story).
 *   - `createRunnerDependencies` — assembles the runner registry the
 *     `ProcessingWorker` consumes.
 *   - `resolveProcessorMode` / `isProcessorMode` for diagnostics.
 */
export {
  createS3ProviderObjectIO,
  PROVIDER_IO_ROUTING_FAILED_MESSAGE,
  PROVIDER_IO_NOT_FOUND_MESSAGE,
  type S3ProviderObjectIODependencies,
} from './provider-io';

export {
  PostgresStorageVariantWriter,
  VARIANT_WRITER_OVERWRITES_ORIGINAL_MESSAGE,
  VARIANT_WRITER_PARENT_NOT_FOUND_MESSAGE,
  type PostgresStorageVariantWriterDeps,
} from './variant-writer';

export { StubDocumentProcessor, StubImageProcessor, StubVideoProcessor } from './stub-processors';

export {
  ProductionDocumentProcessorStub,
  ProductionImageProcessorStub,
  ProductionVideoProcessorStub,
} from './production-processors';

export {
  LibreOfficeDocumentProcessor,
  DEFAULT_SOFFICE_TIMEOUT_MS,
  defaultFetchSidecarClient,
  validateSidecarUrl,
  buildConvertUrl,
  type DocumentSidecarClient,
  type DocumentSidecarConvertResult,
  type LibreOfficeDocumentProcessorDeps,
} from './libreoffice-document-processor';

export {
  ClamavMalwareScanner,
  DEFAULT_CLAMD_HOST,
  DEFAULT_CLAMD_PORT,
  DEFAULT_CLAMD_TIMEOUT_MS,
  type ClamavMalwareScannerOptions,
} from './clamav-scanner';

export {
  createRunnerDependencies,
  isProcessorMode,
  PROCESSOR_MODES,
  resolveProcessorMode,
  type ProcessorMode,
  type ResolvedRunnerDependencies,
  type RunnerDependenciesOptions,
} from './runner-dependencies';
