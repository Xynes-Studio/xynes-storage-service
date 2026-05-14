/**
 * STORAGE-8 — image-optimize runner unit tests.
 *
 * Non-required job. Generates the small/medium/large variants for the
 * active profile, writes each to a distinct derivative provider key,
 * and records each variant via `StorageVariantWriter`.
 *
 * Critical invariants:
 *   - Never overwrites the original `providerObjectKey`.
 *   - EXIF stripping is the processor's responsibility (asserted by
 *     contract — `ImageProcessor.renderVariant` doc-comment requires
 *     it).
 *   - Closed-set error codes only — no provider error text bubbles up.
 */
import { describe, expect, test } from 'bun:test';
import { createImageOptimizeRunner } from '../../../../../src/actions/handlers/processing/runners/image';
import {
  DEFAULT_QUALITY_PROFILE,
  getImageProfile,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIMENSION,
} from '../../../../../src/actions/handlers/processing/runners/profiles';
import {
  FakeImageProcessor,
  FakeProviderIO,
  FakeVariantWriter,
  makeBytes,
  seedClaimedJob,
  seedImageObject,
} from './_fakes';
import { seedObject } from '../_fakes';

function build() {
  const providerIO = new FakeProviderIO();
  const processor = new FakeImageProcessor();
  const variants = new FakeVariantWriter();
  const runner = createImageOptimizeRunner({ providerIO, processor, variants });
  return { providerIO, processor, variants, runner };
}

describe('image-optimize runner — happy path', () => {
  test('writes one variant per spec for the balanced profile', async () => {
    const { providerIO, variants, runner } = build();
    const object = seedImageObject();
    providerIO.preload(object.providerObjectKey, makeBytes(64), 'image/jpeg');
    const out = await runner({ object, job: seedClaimedJob() });
    expect(out).toEqual({});
    const balanced = getImageProfile('balanced');
    expect(variants.records).toHaveLength(balanced.variants.length);
  });

  test('records each variant under <parent-dir>/variants/<role>.<ext>', async () => {
    const { providerIO, variants, runner } = build();
    const object = seedImageObject({
      providerObjectKey: 'workspaces/ws/objects/obj/photo.jpg',
    });
    providerIO.preload(object.providerObjectKey, makeBytes(64), 'image/jpeg');
    await runner({ object, job: seedClaimedJob() });
    for (const rec of variants.records) {
      expect(rec.providerObjectKey.startsWith('workspaces/ws/objects/obj/variants/')).toBe(true);
      expect(rec.providerObjectKey).not.toBe(object.providerObjectKey);
    }
  });

  test('never overwrites the original (writes use ifAbsent=true)', async () => {
    const { providerIO, runner } = build();
    const object = seedImageObject();
    providerIO.preload(object.providerObjectKey, makeBytes(64), 'image/jpeg');
    await runner({ object, job: seedClaimedJob() });
    for (const w of providerIO.writes) {
      expect(w.ifAbsent).toBe(true);
      expect(w.objectKey).not.toBe(object.providerObjectKey);
    }
  });

  test('records workspaceId + objectId on every variant for repo-side scoping', async () => {
    const { providerIO, variants, runner } = build();
    const object = seedImageObject();
    providerIO.preload(object.providerObjectKey, makeBytes(64));
    await runner({ object, job: seedClaimedJob() });
    for (const rec of variants.records) {
      expect(rec.workspaceId).toBe(object.workspaceId);
      expect(rec.objectId).toBe(object.id);
    }
  });
});

describe('image-optimize runner — profile selection', () => {
  test('uses DEFAULT_QUALITY_PROFILE when payload.qualityProfile is missing', async () => {
    const { providerIO, variants, runner } = build();
    const object = seedImageObject();
    providerIO.preload(object.providerObjectKey, makeBytes(64));
    await runner({ object, job: seedClaimedJob({ payload: {} }) });
    expect(variants.records).toHaveLength(getImageProfile(DEFAULT_QUALITY_PROFILE).variants.length);
  });

  test('respects payload.qualityProfile = high_quality (adds original_fallback)', async () => {
    const { providerIO, variants, runner } = build();
    const object = seedImageObject();
    providerIO.preload(object.providerObjectKey, makeBytes(64));
    await runner({ object, job: seedClaimedJob({ payload: { qualityProfile: 'high_quality' } }) });
    const roles = variants.records.map((r) => r.role);
    expect(roles).toContain('original_fallback');
  });

  test('falls back to default when payload.qualityProfile is bogus', async () => {
    const { providerIO, variants, runner } = build();
    const object = seedImageObject();
    providerIO.preload(object.providerObjectKey, makeBytes(64));
    await runner({ object, job: seedClaimedJob({ payload: { qualityProfile: 'ultra' } }) });
    expect(variants.records).toHaveLength(getImageProfile(DEFAULT_QUALITY_PROFILE).variants.length);
  });
});

describe('image-optimize runner — guard rails', () => {
  test('returns UNSUPPORTED_FORMAT when content type is not an image', async () => {
    const { runner } = build();
    const object = seedObject({ contentType: 'application/pdf', byteSize: 1024 });
    const out = await runner({ object, job: seedClaimedJob() });
    expect(out).toEqual({ errorCode: 'UNSUPPORTED_FORMAT', retryable: false });
  });

  test('returns OVER_MAX_BYTES when image exceeds 50 MiB cap (before processor)', async () => {
    const { processor, runner } = build();
    const object = seedImageObject({ byteSize: MAX_IMAGE_BYTES + 1 });
    const out = await runner({ object, job: seedClaimedJob() });
    expect(out).toEqual({ errorCode: 'OVER_MAX_BYTES', retryable: false });
    // Processor was never called.
    expect(processor.renderCalls).toHaveLength(0);
  });

  test('returns OVER_MAX_DIMENSIONS when probe reports dimensions over the hard cap', async () => {
    const { providerIO, processor, runner } = build();
    processor.probeResult = {
      width: MAX_IMAGE_DIMENSION + 1,
      height: 100,
      format: 'jpeg',
    };
    const object = seedImageObject();
    providerIO.preload(object.providerObjectKey, makeBytes(8));
    const out = await runner({ object, job: seedClaimedJob() });
    expect(out).toEqual({ errorCode: 'OVER_MAX_DIMENSIONS', retryable: false });
    // No variants were rendered.
    expect(processor.renderCalls).toHaveLength(0);
  });

  test('returns OVER_MAX_DIMENSIONS when height exceeds the cap (separate branch)', async () => {
    const { providerIO, processor, runner } = build();
    processor.probeResult = {
      width: 100,
      height: MAX_IMAGE_DIMENSION + 1,
      format: 'jpeg',
    };
    const object = seedImageObject();
    providerIO.preload(object.providerObjectKey, makeBytes(8));
    const out = await runner({ object, job: seedClaimedJob() });
    expect(out).toEqual({ errorCode: 'OVER_MAX_DIMENSIONS', retryable: false });
  });
});

describe('image-optimize runner — error mapping', () => {
  test('returns retryable PROCESSOR_FAILED when provider read throws', async () => {
    const { providerIO, runner } = build();
    providerIO.throwOnReadOnce = new Error('Network reset by peer');
    const object = seedImageObject();
    const out = await runner({ object, job: seedClaimedJob() });
    expect(out).toEqual({ errorCode: 'PROCESSOR_FAILED', retryable: true });
  });

  test('returns retryable PROCESSOR_FAILED when processor probe throws', async () => {
    const { providerIO, processor, runner } = build();
    const object = seedImageObject();
    providerIO.preload(object.providerObjectKey, makeBytes(8));
    processor.throwOnProbeOnce = new Error('libvips: malformed jpeg');
    const out = await runner({ object, job: seedClaimedJob() });
    expect(out).toEqual({ errorCode: 'PROCESSOR_FAILED', retryable: true });
  });

  test('returns retryable PROCESSOR_FAILED when processor render throws', async () => {
    const { providerIO, processor, runner } = build();
    const object = seedImageObject();
    providerIO.preload(object.providerObjectKey, makeBytes(8));
    processor.throwOnRenderOnce = new Error('libvips: out of memory');
    const out = await runner({ object, job: seedClaimedJob() });
    expect(out).toEqual({ errorCode: 'PROCESSOR_FAILED', retryable: true });
  });

  test('returns retryable PROCESSOR_FAILED when variant write throws', async () => {
    const { providerIO, runner } = build();
    const object = seedImageObject();
    providerIO.preload(object.providerObjectKey, makeBytes(8));
    providerIO.throwOnWriteOnce = new Error('s3 NoSuchBucket');
    const out = await runner({ object, job: seedClaimedJob() });
    expect(out).toEqual({ errorCode: 'PROCESSOR_FAILED', retryable: true });
  });

  test('never embeds provider / library error text into the errorCode', async () => {
    const { providerIO, processor, runner } = build();
    const object = seedImageObject();
    providerIO.preload(object.providerObjectKey, makeBytes(8));
    processor.throwOnProbeOnce = new Error('libvips: malformed jpeg at offset 0xDEADBEEF');
    const out = (await runner({ object, job: seedClaimedJob() })) as {
      errorCode: string;
    };
    expect(out.errorCode).toBe('PROCESSOR_FAILED');
    expect(out.errorCode).not.toContain('libvips');
    expect(out.errorCode).not.toContain('0xDEADBEEF');
  });
});

describe('image-optimize runner — variant content (security)', () => {
  test('never writes a variant to the original provider key (defense in depth)', async () => {
    const { providerIO, variants, runner } = build();
    const object = seedImageObject({
      providerObjectKey: 'workspaces/ws/objects/obj/photo.jpg',
    });
    providerIO.preload(object.providerObjectKey, makeBytes(8));
    await runner({ object, job: seedClaimedJob() });
    for (const w of providerIO.writes) {
      expect(w.objectKey).not.toBe(object.providerObjectKey);
    }
    for (const rec of variants.records) {
      expect(rec.providerObjectKey).not.toBe(object.providerObjectKey);
    }
  });

  test('variant content types are AVIF/WebP/JPEG only (no original-format passthrough by default)', async () => {
    const { providerIO, variants, runner } = build();
    const object = seedImageObject();
    providerIO.preload(object.providerObjectKey, makeBytes(8));
    await runner({ object, job: seedClaimedJob() });
    const allowed = new Set(['image/avif', 'image/webp', 'image/jpeg']);
    for (const rec of variants.records) {
      expect(allowed.has(rec.contentType)).toBe(true);
    }
  });
});
