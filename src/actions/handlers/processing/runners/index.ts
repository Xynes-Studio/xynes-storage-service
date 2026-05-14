/**
 * STORAGE-8 — runners barrel re-exports.
 *
 * Public surface:
 *   - Closed-set error codes + classes.
 *   - Named quality profiles.
 *   - DI port contracts (ImageProcessor, VideoProcessor, ...).
 *   - Per-job-type runner factories.
 *   - `createRunnerRegistry` for the full
 *     `Partial<Record<ProcessingJobType, JobRunner>>` map.
 *
 * Internal helpers (variant-keys, runner-utils) are intentionally NOT
 * re-exported — they are implementation details of the runners.
 */
export {
  RUNNER_ERROR_CODES,
  RunnerInputError,
  RunnerExecutionError,
  isRunnerError,
  type RunnerErrorCode,
} from './errors';

export {
  QUALITY_PROFILES,
  DEFAULT_QUALITY_PROFILE,
  isQualityProfile,
  getImageProfile,
  getVideoProfile,
  IMAGE_VARIANT_ROLES,
  VIDEO_VARIANT_ROLES,
  DOCUMENT_VARIANT_ROLES,
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  MAX_DOCUMENT_BYTES,
  MAX_IMAGE_DIMENSION,
  MAX_VIDEO_DIMENSION,
  MAX_VIDEO_DURATION_SECONDS,
  isSafeDocumentPreviewMime,
  SAFE_DOCUMENT_PREVIEW_MIMES,
  type QualityProfile,
  type ImageProfile,
  type ImageVariantSpec,
  type ImageVariantRole,
  type VideoProfile,
  type VideoVariantRole,
  type DocumentVariantRole,
  type VariantRole,
} from './profiles';

export type {
  ProviderObjectIO,
  StorageVariantWriter,
  VariantRecord,
  ImageProcessor,
  ImageProbeResult,
  ImageVariantRender,
  VideoProcessor,
  VideoProbeResult,
  VideoPosterRender,
  VideoTranscodeRender,
  DocumentProcessor,
  DocumentPreviewRender,
  MalwareScanner,
  MalwareScanResult,
} from './ports';
export { noopMalwareScanner } from './ports';

export {
  createScanValidationRunner,
  type ScanValidationRunnerDependencies,
} from './scan-validation';
export { createImageOptimizeRunner, type ImageOptimizeRunnerDependencies } from './image';
export {
  createVideoProbeRunner,
  createVideoThumbnailRunner,
  createVideoTranscodeRunner,
  type VideoProbeRunnerDependencies,
  type VideoThumbnailRunnerDependencies,
  type VideoTranscodeRunnerDependencies,
} from './video';
export { createDocumentPreviewRunner, type DocumentPreviewRunnerDependencies } from './document';

export { createRunnerRegistry, type RunnerRegistryDependencies } from './registry';
