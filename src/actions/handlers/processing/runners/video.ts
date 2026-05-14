/**
 * STORAGE-8 — video processing runners.
 *
 * Per STORAGE-8 acceptance criteria:
 *   - `video_probe`     (REQUIRED — flips parent to `failed` on miss)
 *       Uses ffprobe-equivalent to read duration, dimensions, codec,
 *       and rotation. Acts as the safety gate before expensive
 *       transcoding — over-cap inputs are rejected here so
 *       `video_thumbnail` / `video_transcode` never burn worker time
 *       on a 4-hour 8K stream.
 *   - `video_thumbnail` (not required) — generates a poster frame
 *       using the dimensions defined by the active profile.
 *   - `video_transcode` (not required) — generates H.264/AAC MP4 as
 *       the first normalized playback format. AV1/WebM are deferred
 *       per STORAGE-8 "out of scope".
 *
 * All three runners share `runRunnerWithErrorMapping` and the closed-set
 * error codes (`OVER_MAX_BYTES`, `OVER_MAX_DURATION`,
 * `OVER_MAX_DIMENSIONS`, `UNSUPPORTED_FORMAT`, `PROCESSOR_FAILED`).
 */
import { classifyContentType } from '../../objects/schemas';
import type { JobRunner, JobRunResult } from '../types';
import { RunnerExecutionError, RunnerInputError } from './errors';
import {
  DEFAULT_QUALITY_PROFILE,
  getVideoProfile,
  isQualityProfile,
  MAX_VIDEO_BYTES,
  MAX_VIDEO_DIMENSION,
  MAX_VIDEO_DURATION_SECONDS,
  type QualityProfile,
} from './profiles';
import type {
  ProviderObjectIO,
  StorageVariantWriter,
  VideoProbeResult,
  VideoProcessor,
} from './ports';
import { runRunnerWithErrorMapping } from './runner-utils';
import { deriveVariantObjectKey } from './variant-keys';

function resolveProfile(payload: Readonly<Record<string, unknown>>): QualityProfile {
  const raw = (payload as { qualityProfile?: unknown }).qualityProfile;
  return isQualityProfile(raw) ? raw : DEFAULT_QUALITY_PROFILE;
}

async function ensureVideoAndReadBytes(input: {
  providerIO: ProviderObjectIO;
  object: {
    contentType: string;
    byteSize: number;
    providerObjectKey: string;
  };
}): Promise<Uint8Array> {
  const { providerIO, object } = input;
  if (classifyContentType(object.contentType) !== 'video') {
    throw new RunnerInputError('UNSUPPORTED_FORMAT');
  }
  if (object.byteSize > MAX_VIDEO_BYTES) {
    throw new RunnerInputError('OVER_MAX_BYTES');
  }
  try {
    return await providerIO.readObject({ objectKey: object.providerObjectKey });
  } catch {
    throw new RunnerExecutionError('PROCESSOR_FAILED', { retryable: true });
  }
}

// ── video_probe (REQUIRED) ───────────────────────────────────────────────

export interface VideoProbeRunnerDependencies {
  readonly providerIO: ProviderObjectIO;
  readonly processor: VideoProcessor;
}

/**
 * The probe runner is the safety gate. It validates dimensions +
 * duration BEFORE the non-required thumbnail / transcode runners get
 * scheduled. A failed probe flips the parent to `failed` via the
 * STORAGE-7 aggregator (probe is required).
 */
export function createVideoProbeRunner(deps: VideoProbeRunnerDependencies): JobRunner {
  return async ({ object }): Promise<JobRunResult | void> => {
    return runRunnerWithErrorMapping(async () => {
      const bytes = await ensureVideoAndReadBytes({
        providerIO: deps.providerIO,
        object,
      });
      let probe: VideoProbeResult;
      try {
        probe = await deps.processor.probe({ bytes });
      } catch {
        throw new RunnerExecutionError('PROCESSOR_FAILED', { retryable: true });
      }
      if (probe.durationSeconds > MAX_VIDEO_DURATION_SECONDS) {
        throw new RunnerInputError('OVER_MAX_DURATION');
      }
      if (probe.width > MAX_VIDEO_DIMENSION || probe.height > MAX_VIDEO_DIMENSION) {
        throw new RunnerInputError('OVER_MAX_DIMENSIONS');
      }
      return {};
    });
  };
}

// ── video_thumbnail (not required) ───────────────────────────────────────

export interface VideoThumbnailRunnerDependencies {
  readonly providerIO: ProviderObjectIO;
  readonly processor: VideoProcessor;
  readonly variants: StorageVariantWriter;
}

export function createVideoThumbnailRunner(deps: VideoThumbnailRunnerDependencies): JobRunner {
  return async ({ job, object }): Promise<JobRunResult | void> => {
    return runRunnerWithErrorMapping(async () => {
      const bytes = await ensureVideoAndReadBytes({
        providerIO: deps.providerIO,
        object,
      });
      const profile = getVideoProfile(resolveProfile(job.payload));

      let render;
      try {
        render = await deps.processor.renderPoster({ bytes, profile });
      } catch {
        throw new RunnerExecutionError('PROCESSOR_FAILED', { retryable: true });
      }

      const variantKey = deriveVariantObjectKey({
        parentObjectKey: object.providerObjectKey,
        role: 'poster',
        contentType: render.contentType,
      });

      let written;
      try {
        written = await deps.providerIO.writeObject({
          objectKey: variantKey,
          body: render.bytes,
          contentType: render.contentType,
          ifAbsent: true,
        });
      } catch {
        throw new RunnerExecutionError('PROCESSOR_FAILED', { retryable: true });
      }

      await deps.variants.recordVariant({
        objectId: object.id,
        workspaceId: object.workspaceId,
        role: 'poster',
        providerObjectKey: variantKey,
        contentType: render.contentType,
        byteSize: written.byteSize,
        width: render.width,
        height: render.height,
      });

      return {};
    });
  };
}

// ── video_transcode (not required) ───────────────────────────────────────

export interface VideoTranscodeRunnerDependencies {
  readonly providerIO: ProviderObjectIO;
  readonly processor: VideoProcessor;
  readonly variants: StorageVariantWriter;
}

export function createVideoTranscodeRunner(deps: VideoTranscodeRunnerDependencies): JobRunner {
  return async ({ job, object }): Promise<JobRunResult | void> => {
    return runRunnerWithErrorMapping(async () => {
      const bytes = await ensureVideoAndReadBytes({
        providerIO: deps.providerIO,
        object,
      });
      const profile = getVideoProfile(resolveProfile(job.payload));

      let render;
      try {
        render = await deps.processor.renderTranscode({ bytes, profile });
      } catch {
        throw new RunnerExecutionError('PROCESSOR_FAILED', { retryable: true });
      }

      const variantKey = deriveVariantObjectKey({
        parentObjectKey: object.providerObjectKey,
        role: 'transcode_h264',
        contentType: render.contentType,
      });

      let written;
      try {
        written = await deps.providerIO.writeObject({
          objectKey: variantKey,
          body: render.bytes,
          contentType: render.contentType,
          ifAbsent: true,
        });
      } catch {
        throw new RunnerExecutionError('PROCESSOR_FAILED', { retryable: true });
      }

      await deps.variants.recordVariant({
        objectId: object.id,
        workspaceId: object.workspaceId,
        role: 'transcode_h264',
        providerObjectKey: variantKey,
        contentType: render.contentType,
        byteSize: written.byteSize,
        width: render.width,
        height: render.height,
        durationSeconds: render.durationSeconds,
      });

      return {};
    });
  };
}
