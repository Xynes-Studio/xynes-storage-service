/**
 * STORAGE-8 — runner registry factory.
 *
 * `createRunnerRegistry(deps)` returns the full
 * `Partial<Record<ProcessingJobType, JobRunner>>` that
 * `ProcessingWorker.runners` expects. Every job type the STORAGE-7
 * planner can emit has a runner — no "RUNNER_MISSING" in production.
 *
 * Production wiring (follow-up infra story) builds the dependencies
 * by adapting the existing `StorageProviderAdapter` to the narrow
 * `ProviderObjectIO` port, the Drizzle-backed
 * `platform.storage_object_variants` writer to `StorageVariantWriter`,
 * and the sharp / ffmpeg / libreoffice native bindings (or remote
 * sidecars) to `ImageProcessor` / `VideoProcessor` /
 * `DocumentProcessor`.
 *
 * For local dev / tests, every port is fakeable.
 */
import type { JobRunner, ProcessingJobType } from '../types';
import { createDocumentPreviewRunner } from './document';
import { createImageOptimizeRunner } from './image';
import type {
  DocumentProcessor,
  ImageProcessor,
  MalwareScanner,
  ProviderObjectIO,
  StorageVariantWriter,
  VideoProcessor,
} from './ports';
import { createScanValidationRunner } from './scan-validation';
import {
  createVideoProbeRunner,
  createVideoThumbnailRunner,
  createVideoTranscodeRunner,
} from './video';

export interface RunnerRegistryDependencies {
  readonly providerIO: ProviderObjectIO;
  readonly variants: StorageVariantWriter;
  readonly scanner: MalwareScanner;
  readonly image: ImageProcessor;
  readonly video: VideoProcessor;
  readonly document: DocumentProcessor;
}

export function createRunnerRegistry(
  deps: RunnerRegistryDependencies,
): Readonly<Partial<Record<ProcessingJobType, JobRunner>>> {
  return Object.freeze({
    scan_validation: createScanValidationRunner({
      providerIO: deps.providerIO,
      scanner: deps.scanner,
    }),
    image_optimize: createImageOptimizeRunner({
      providerIO: deps.providerIO,
      processor: deps.image,
      variants: deps.variants,
    }),
    video_probe: createVideoProbeRunner({
      providerIO: deps.providerIO,
      processor: deps.video,
    }),
    video_thumbnail: createVideoThumbnailRunner({
      providerIO: deps.providerIO,
      processor: deps.video,
      variants: deps.variants,
    }),
    video_transcode: createVideoTranscodeRunner({
      providerIO: deps.providerIO,
      processor: deps.video,
      variants: deps.variants,
    }),
    document_preview: createDocumentPreviewRunner({
      providerIO: deps.providerIO,
      processor: deps.document,
      variants: deps.variants,
    }),
  });
}
