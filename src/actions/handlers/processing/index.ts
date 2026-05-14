/**
 * STORAGE-7 — action-key dispatcher for processing retry.
 *
 * Action key: `platform.storage.objects.process.retry` (per STORAGE-3
 * route seeds + plan §7). The gateway routes a single `POST` here; the
 * service distinguishes the operation via the payload-level `operation`
 * discriminator (same posture as STORAGE-5 / STORAGE-6 dispatchers).
 */
import { ValidationError } from '../../errors';
import { registerHandler } from '../../registry';
import type { ActionContext } from '../../types';
import { createRetryProcessingHandler } from './retry';
import type { RetryHandlerDependencies } from './types';

export const STORAGE_PROCESS_RETRY_ACTION_KEY = 'platform.storage.objects.process.retry' as const;

function hasOperation(payload: unknown): payload is { operation: unknown } {
  return typeof payload === 'object' && payload !== null && 'operation' in payload;
}

export function buildProcessingActionHandler(deps: RetryHandlerDependencies) {
  const retry = createRetryProcessingHandler(deps);

  return async (payload: unknown, ctx: ActionContext): Promise<unknown> => {
    if (!hasOperation(payload)) {
      throw new ValidationError('Payload `operation` is required (must be: retry)');
    }
    const op = (payload as { operation: unknown }).operation;
    if (op !== 'retry') {
      throw new ValidationError('Payload `operation` must be: retry');
    }
    return retry(payload, ctx);
  };
}

export function registerProcessingActionHandlers(deps: RetryHandlerDependencies): void {
  registerHandler(STORAGE_PROCESS_RETRY_ACTION_KEY, buildProcessingActionHandler(deps));
}

export { createRetryProcessingHandler } from './retry';
export { ProcessingWorker, noopScanValidationRunner } from './worker';
export { planProcessingJobs, planProcessingJobTypes } from './planner';
export { computeAggregateStatus } from './aggregator';
export { enqueueProcessingForObject } from './enqueue';
export {
  PROCESSING_JOB_TYPES,
  type ProcessingJobType,
  type ProcessingJobPlan,
  type ProcessingJobQueueRepository,
  type StorageObjectStatusRepository,
  type ProcessingWorkerDependencies,
  type JobRunner,
  type JobRunnerContext,
  type JobRunResult,
  type ClaimedJob,
  type EnqueueJobInput,
  type EnqueueDependencies,
  type RetryHandlerDependencies,
} from './types';
export { retryProcessingPayloadSchema, processingActionPayloadSchema } from './schemas';

// STORAGE-8 — runner factories + DI ports + named quality profiles.
export {
  createRunnerRegistry,
  createScanValidationRunner,
  createImageOptimizeRunner,
  createVideoProbeRunner,
  createVideoThumbnailRunner,
  createVideoTranscodeRunner,
  createDocumentPreviewRunner,
  RUNNER_ERROR_CODES,
  RunnerInputError,
  RunnerExecutionError,
  isRunnerError,
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
  noopMalwareScanner,
  type RunnerErrorCode,
  type QualityProfile,
  type ImageProfile,
  type ImageVariantSpec,
  type ImageVariantRole,
  type VideoProfile,
  type VideoVariantRole,
  type DocumentVariantRole,
  type VariantRole,
  type ProviderObjectIO,
  type StorageVariantWriter,
  type VariantRecord,
  type ImageProcessor,
  type ImageProbeResult,
  type ImageVariantRender,
  type VideoProcessor,
  type VideoProbeResult,
  type VideoPosterRender,
  type VideoTranscodeRender,
  type DocumentProcessor,
  type DocumentPreviewRender,
  type MalwareScanner,
  type MalwareScanResult,
  type RunnerRegistryDependencies,
  type ScanValidationRunnerDependencies,
  type ImageOptimizeRunnerDependencies,
  type VideoProbeRunnerDependencies,
  type VideoThumbnailRunnerDependencies,
  type VideoTranscodeRunnerDependencies,
  type DocumentPreviewRunnerDependencies,
} from './runners';
