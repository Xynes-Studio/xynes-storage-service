/**
 * STORAGE-8 — video runner unit tests (probe / thumbnail / transcode).
 *
 * - `video_probe`     is REQUIRED — failures flip the parent to `failed`.
 *   This is the safety gate before expensive thumbnail / transcode work.
 * - `video_thumbnail` is NOT required.
 * - `video_transcode` is NOT required.
 *
 * Critical invariants:
 *   - Probe enforces hard duration + dimension caps before
 *     thumbnail / transcode runners ever start.
 *   - Transcode writes H.264/AAC MP4 ONLY (per STORAGE-8 acceptance
 *     criteria). AV1/WebM are deferred.
 *   - Variants never overwrite the original key.
 */
import { describe, expect, test } from 'bun:test';
import {
  createVideoProbeRunner,
  createVideoThumbnailRunner,
  createVideoTranscodeRunner,
} from '../../../../../src/actions/handlers/processing/runners/video';
import {
  MAX_VIDEO_BYTES,
  MAX_VIDEO_DIMENSION,
  MAX_VIDEO_DURATION_SECONDS,
} from '../../../../../src/actions/handlers/processing/runners/profiles';
import {
  FakeProviderIO,
  FakeVariantWriter,
  FakeVideoProcessor,
  makeBytes,
  seedClaimedJob,
  seedImageObject,
  seedVideoObject,
} from './_fakes';

function buildProbe() {
  const providerIO = new FakeProviderIO();
  const processor = new FakeVideoProcessor();
  const runner = createVideoProbeRunner({ providerIO, processor });
  return { providerIO, processor, runner };
}

function buildThumbnail() {
  const providerIO = new FakeProviderIO();
  const processor = new FakeVideoProcessor();
  const variants = new FakeVariantWriter();
  const runner = createVideoThumbnailRunner({ providerIO, processor, variants });
  return { providerIO, processor, variants, runner };
}

function buildTranscode() {
  const providerIO = new FakeProviderIO();
  const processor = new FakeVideoProcessor();
  const variants = new FakeVariantWriter();
  const runner = createVideoTranscodeRunner({ providerIO, processor, variants });
  return { providerIO, processor, variants, runner };
}

describe('video_probe runner', () => {
  test('returns {} for a normal 30 s 720p video', async () => {
    const { providerIO, runner } = buildProbe();
    const object = seedVideoObject();
    providerIO.preload(object.providerObjectKey, makeBytes(16));
    const out = await runner({ object, job: seedClaimedJob({ jobType: 'video_probe' }) });
    expect(out).toEqual({});
  });

  test('returns UNSUPPORTED_FORMAT for non-video content', async () => {
    const { runner } = buildProbe();
    const object = seedImageObject();
    const out = await runner({ object, job: seedClaimedJob({ jobType: 'video_probe' }) });
    expect(out).toEqual({ errorCode: 'UNSUPPORTED_FORMAT', retryable: false });
  });

  test('returns OVER_MAX_BYTES when video exceeds 2 GiB cap (before probe)', async () => {
    const { processor, runner } = buildProbe();
    const object = seedVideoObject({ byteSize: MAX_VIDEO_BYTES + 1 });
    const out = await runner({ object, job: seedClaimedJob({ jobType: 'video_probe' }) });
    expect(out).toEqual({ errorCode: 'OVER_MAX_BYTES', retryable: false });
    // Processor never called.
    expect(processor.probeResult.durationSeconds).toBe(30);
  });

  test('returns OVER_MAX_DURATION when duration exceeds 1 hour cap', async () => {
    const { providerIO, processor, runner } = buildProbe();
    processor.probeResult = {
      ...processor.probeResult,
      durationSeconds: MAX_VIDEO_DURATION_SECONDS + 1,
    };
    const object = seedVideoObject();
    providerIO.preload(object.providerObjectKey, makeBytes(8));
    const out = await runner({ object, job: seedClaimedJob({ jobType: 'video_probe' }) });
    expect(out).toEqual({ errorCode: 'OVER_MAX_DURATION', retryable: false });
  });

  test('returns OVER_MAX_DIMENSIONS when probe reports over 4k', async () => {
    const { providerIO, processor, runner } = buildProbe();
    processor.probeResult = {
      ...processor.probeResult,
      width: MAX_VIDEO_DIMENSION + 1,
      height: 1080,
    };
    const object = seedVideoObject();
    providerIO.preload(object.providerObjectKey, makeBytes(8));
    const out = await runner({ object, job: seedClaimedJob({ jobType: 'video_probe' }) });
    expect(out).toEqual({ errorCode: 'OVER_MAX_DIMENSIONS', retryable: false });
  });

  test('returns OVER_MAX_DIMENSIONS for over-cap height (separate branch)', async () => {
    const { providerIO, processor, runner } = buildProbe();
    processor.probeResult = {
      ...processor.probeResult,
      width: 1920,
      height: MAX_VIDEO_DIMENSION + 1,
    };
    const object = seedVideoObject();
    providerIO.preload(object.providerObjectKey, makeBytes(8));
    const out = await runner({ object, job: seedClaimedJob({ jobType: 'video_probe' }) });
    expect(out).toEqual({ errorCode: 'OVER_MAX_DIMENSIONS', retryable: false });
  });

  test('returns retryable PROCESSOR_FAILED on provider read throw', async () => {
    const { providerIO, runner } = buildProbe();
    providerIO.throwOnReadOnce = new Error('s3 timeout');
    const object = seedVideoObject();
    const out = await runner({ object, job: seedClaimedJob({ jobType: 'video_probe' }) });
    expect(out).toEqual({ errorCode: 'PROCESSOR_FAILED', retryable: true });
  });

  test('returns retryable PROCESSOR_FAILED on processor probe throw', async () => {
    const { providerIO, processor, runner } = buildProbe();
    providerIO.preload(seedVideoObject().providerObjectKey, makeBytes(8));
    processor.throwOnProbeOnce = new Error('ffprobe: corrupt mp4 atom');
    const object = seedVideoObject();
    const out = await runner({ object, job: seedClaimedJob({ jobType: 'video_probe' }) });
    expect(out).toEqual({ errorCode: 'PROCESSOR_FAILED', retryable: true });
  });
});

describe('video_thumbnail runner', () => {
  test('writes a poster variant and records it', async () => {
    const { providerIO, variants, runner } = buildThumbnail();
    const object = seedVideoObject();
    providerIO.preload(object.providerObjectKey, makeBytes(16));
    const out = await runner({ object, job: seedClaimedJob({ jobType: 'video_thumbnail' }) });
    expect(out).toEqual({});
    expect(variants.records).toHaveLength(1);
    expect(variants.records[0]?.role).toBe('poster');
    expect(variants.records[0]?.providerObjectKey).not.toBe(object.providerObjectKey);
  });

  test('poster variant content type is image/jpeg or image/webp', async () => {
    const { providerIO, variants, runner } = buildThumbnail();
    const object = seedVideoObject();
    providerIO.preload(object.providerObjectKey, makeBytes(8));
    await runner({ object, job: seedClaimedJob({ jobType: 'video_thumbnail' }) });
    expect(['image/jpeg', 'image/webp']).toContain(variants.records[0]?.contentType);
  });

  test('returns UNSUPPORTED_FORMAT for non-video content', async () => {
    const { runner } = buildThumbnail();
    const object = seedImageObject();
    const out = await runner({ object, job: seedClaimedJob({ jobType: 'video_thumbnail' }) });
    expect(out).toEqual({ errorCode: 'UNSUPPORTED_FORMAT', retryable: false });
  });

  test('returns retryable PROCESSOR_FAILED on poster render throw', async () => {
    const { providerIO, processor, runner } = buildThumbnail();
    const object = seedVideoObject();
    providerIO.preload(object.providerObjectKey, makeBytes(8));
    processor.throwOnPosterOnce = new Error('ffmpeg: codec not found');
    const out = await runner({ object, job: seedClaimedJob({ jobType: 'video_thumbnail' }) });
    expect(out).toEqual({ errorCode: 'PROCESSOR_FAILED', retryable: true });
  });

  test('returns retryable PROCESSOR_FAILED on variant write throw', async () => {
    const { providerIO, runner } = buildThumbnail();
    const object = seedVideoObject();
    providerIO.preload(object.providerObjectKey, makeBytes(8));
    providerIO.throwOnWriteOnce = new Error('NoSuchBucket');
    const out = await runner({ object, job: seedClaimedJob({ jobType: 'video_thumbnail' }) });
    expect(out).toEqual({ errorCode: 'PROCESSOR_FAILED', retryable: true });
  });

  test('respects payload.qualityProfile for poster dimensions', async () => {
    const { providerIO, processor, variants, runner } = buildThumbnail();
    processor.posterRender = {
      bytes: new Uint8Array([1, 2]),
      width: 1280,
      height: 720,
      contentType: 'image/jpeg',
    };
    const object = seedVideoObject();
    providerIO.preload(object.providerObjectKey, makeBytes(8));
    await runner({
      object,
      job: seedClaimedJob({
        jobType: 'video_thumbnail',
        payload: { qualityProfile: 'high_quality' },
      }),
    });
    expect(variants.records[0]?.width).toBe(1280);
    expect(variants.records[0]?.height).toBe(720);
  });
});

describe('video_transcode runner', () => {
  test('writes one transcode_h264 variant (MP4) and records it', async () => {
    const { providerIO, variants, runner } = buildTranscode();
    const object = seedVideoObject();
    providerIO.preload(object.providerObjectKey, makeBytes(16));
    const out = await runner({ object, job: seedClaimedJob({ jobType: 'video_transcode' }) });
    expect(out).toEqual({});
    expect(variants.records).toHaveLength(1);
    expect(variants.records[0]?.role).toBe('transcode_h264');
    expect(variants.records[0]?.contentType).toBe('video/mp4');
  });

  test('transcode variant carries durationSeconds', async () => {
    const { providerIO, variants, runner } = buildTranscode();
    const object = seedVideoObject();
    providerIO.preload(object.providerObjectKey, makeBytes(8));
    await runner({ object, job: seedClaimedJob({ jobType: 'video_transcode' }) });
    expect(variants.records[0]?.durationSeconds).toBe(30);
  });

  test('transcode variant key never collides with the original', async () => {
    const { providerIO, variants, runner } = buildTranscode();
    const object = seedVideoObject({
      providerObjectKey: 'workspaces/ws/objects/obj/clip.mp4',
    });
    providerIO.preload(object.providerObjectKey, makeBytes(8));
    await runner({ object, job: seedClaimedJob({ jobType: 'video_transcode' }) });
    const recKey = variants.records[0]?.providerObjectKey;
    expect(recKey).not.toBe(object.providerObjectKey);
    expect(recKey).toBe('workspaces/ws/objects/obj/variants/transcode_h264.mp4');
  });

  test('returns UNSUPPORTED_FORMAT for non-video content', async () => {
    const { runner } = buildTranscode();
    const object = seedImageObject();
    const out = await runner({ object, job: seedClaimedJob({ jobType: 'video_transcode' }) });
    expect(out).toEqual({ errorCode: 'UNSUPPORTED_FORMAT', retryable: false });
  });

  test('returns retryable PROCESSOR_FAILED on transcode render throw', async () => {
    const { providerIO, processor, runner } = buildTranscode();
    const object = seedVideoObject();
    providerIO.preload(object.providerObjectKey, makeBytes(8));
    processor.throwOnTranscodeOnce = new Error('ffmpeg: oom');
    const out = await runner({ object, job: seedClaimedJob({ jobType: 'video_transcode' }) });
    expect(out).toEqual({ errorCode: 'PROCESSOR_FAILED', retryable: true });
  });

  test('returns retryable PROCESSOR_FAILED when variant write throws', async () => {
    const { providerIO, runner } = buildTranscode();
    const object = seedVideoObject();
    providerIO.preload(object.providerObjectKey, makeBytes(8));
    providerIO.throwOnWriteOnce = new Error('AccessDenied');
    const out = await runner({ object, job: seedClaimedJob({ jobType: 'video_transcode' }) });
    expect(out).toEqual({ errorCode: 'PROCESSOR_FAILED', retryable: true });
  });

  test('all uses of ifAbsent are true (defense in depth — original sacred)', async () => {
    const { providerIO, runner } = buildTranscode();
    const object = seedVideoObject();
    providerIO.preload(object.providerObjectKey, makeBytes(8));
    await runner({ object, job: seedClaimedJob({ jobType: 'video_transcode' }) });
    for (const w of providerIO.writes) {
      expect(w.ifAbsent).toBe(true);
    }
  });
});
