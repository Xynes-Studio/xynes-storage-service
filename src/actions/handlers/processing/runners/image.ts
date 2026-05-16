/**
 * STORAGE-8 — image-optimize runner.
 *
 * Generates the small/medium/large variants for an image upload under
 * the chosen `QualityProfile`. The runner:
 *   1. Pulls bytes via the narrow `ProviderObjectIO` port.
 *   2. Enforces hard caps (byte size + pixel dimensions) BEFORE the
 *      processor runs — defense in depth on top of STORAGE-5's
 *      upload-time cap.
 *   3. Probes via the injected `ImageProcessor`.
 *   4. Renders every variant for the active profile.
 *   5. Writes each variant to a distinct provider key derived under
 *      `<parent>/variants/<role>.<ext>` — the original is NEVER
 *      overwritten (asserted by `deriveVariantObjectKey`).
 *   6. Records each variant via the `StorageVariantWriter` port.
 *
 * Non-required job (per STORAGE-7 planner). A transient libvips
 * failure is `PROCESSOR_FAILED` (retryable); over-cap inputs are
 * non-retryable. EXIF stripping is the processor's responsibility —
 * documented invariant on `ImageProcessor.renderVariant`.
 *
 * Profile selection precedence:
 *   1. `job.payload.qualityProfile` (if a valid `QualityProfile`).
 *   2. `DEFAULT_QUALITY_PROFILE`.
 *
 * The runner NEVER speaks to sharp directly. Production wires a
 * sharp-backed `ImageProcessor`; tests inject a fake that returns
 * deterministic bytes.
 */
import { classifyContentType } from '../../objects/schemas';
import type { JobRunner, JobRunResult } from '../types';
import { RunnerExecutionError, RunnerInputError } from './errors';
import {
  DEFAULT_QUALITY_PROFILE,
  getImageProfile,
  isQualityProfile,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIMENSION,
  type ImageVariantSpec,
  type QualityProfile,
} from './profiles';
import type {
  ImageProcessor,
  ImageVariantRender,
  ProviderObjectIO,
  StorageVariantWriter,
} from './ports';
import { runRunnerWithErrorMapping } from './runner-utils';
import { deriveVariantObjectKey } from './variant-keys';

export interface ImageOptimizeRunnerDependencies {
  readonly providerIO: ProviderObjectIO;
  readonly processor: ImageProcessor;
  readonly variants: StorageVariantWriter;
}

function resolveProfile(payload: Readonly<Record<string, unknown>>): QualityProfile {
  const raw = (payload as { qualityProfile?: unknown }).qualityProfile;
  return isQualityProfile(raw) ? raw : DEFAULT_QUALITY_PROFILE;
}

export function createImageOptimizeRunner(deps: ImageOptimizeRunnerDependencies): JobRunner {
  return async ({ job, object }): Promise<JobRunResult | void> => {
    return runRunnerWithErrorMapping(async () => {
      if (classifyContentType(object.contentType) !== 'image') {
        throw new RunnerInputError('UNSUPPORTED_FORMAT');
      }
      if (object.byteSize > MAX_IMAGE_BYTES) {
        throw new RunnerInputError('OVER_MAX_BYTES');
      }

      const profile = getImageProfile(resolveProfile(job.payload));

      let bytes: Uint8Array;
      try {
        bytes = await deps.providerIO.readObject({
          objectKey: object.providerObjectKey,
          workspaceId: object.workspaceId,
          providerId: object.providerId,
        });
      } catch {
        throw new RunnerExecutionError('PROCESSOR_FAILED', { retryable: true });
      }

      let probe;
      try {
        probe = await deps.processor.probe({ bytes });
      } catch {
        throw new RunnerExecutionError('PROCESSOR_FAILED', { retryable: true });
      }

      if (probe.width > MAX_IMAGE_DIMENSION || probe.height > MAX_IMAGE_DIMENSION) {
        throw new RunnerInputError('OVER_MAX_DIMENSIONS');
      }

      // Render every variant in the profile, write to provider, record row.
      for (const spec of profile.variants) {
        await renderAndRecordVariant({
          deps,
          bytes,
          spec,
          object: {
            id: object.id,
            workspaceId: object.workspaceId,
            providerId: object.providerId,
            providerObjectKey: object.providerObjectKey,
          },
        });
      }

      return {};
    });
  };
}

async function renderAndRecordVariant(input: {
  deps: ImageOptimizeRunnerDependencies;
  bytes: Uint8Array;
  spec: ImageVariantSpec;
  object: { id: string; workspaceId: string; providerId: string; providerObjectKey: string };
}): Promise<void> {
  const { deps, bytes, spec, object } = input;

  let render: ImageVariantRender;
  try {
    render = await deps.processor.renderVariant({ bytes, spec });
  } catch {
    throw new RunnerExecutionError('PROCESSOR_FAILED', { retryable: true });
  }

  const variantKey = deriveVariantObjectKey({
    parentObjectKey: object.providerObjectKey,
    role: spec.role,
    contentType: render.contentType,
  });

  let written: { byteSize: number };
  try {
    written = await deps.providerIO.writeObject({
      objectKey: variantKey,
      body: render.bytes,
      contentType: render.contentType,
      ifAbsent: true,
      workspaceId: object.workspaceId,
      providerId: object.providerId,
    });
  } catch {
    throw new RunnerExecutionError('PROCESSOR_FAILED', { retryable: true });
  }

  await deps.variants.recordVariant({
    objectId: object.id,
    workspaceId: object.workspaceId,
    role: spec.role,
    providerObjectKey: variantKey,
    contentType: render.contentType,
    byteSize: written.byteSize,
    width: render.width,
    height: render.height,
  });
}
