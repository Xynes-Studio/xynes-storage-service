/**
 * STORAGE-8 — registry unit tests.
 *
 * The registry wires the six runners (`scan_validation`,
 * `image_optimize`, `video_probe`, `video_thumbnail`,
 * `video_transcode`, `document_preview`) into the
 * `Partial<Record<ProcessingJobType, JobRunner>>` map the
 * STORAGE-7 `ProcessingWorker.runners` field expects.
 */
import { describe, expect, test } from 'bun:test';
import {
  PROCESSING_JOB_TYPES,
  type ProcessingJobType,
} from '../../../../../src/actions/handlers/processing/types';
import { createRunnerRegistry } from '../../../../../src/actions/handlers/processing/runners/registry';
import {
  FakeDocumentProcessor,
  FakeImageProcessor,
  FakeMalwareScanner,
  FakeProviderIO,
  FakeVariantWriter,
  FakeVideoProcessor,
  makeBytes,
  seedClaimedJob,
  seedDocumentObject,
  seedImageObject,
  seedVideoObject,
} from './_fakes';

function build() {
  const providerIO = new FakeProviderIO();
  const variants = new FakeVariantWriter();
  const scanner = new FakeMalwareScanner();
  const image = new FakeImageProcessor();
  const video = new FakeVideoProcessor();
  const document = new FakeDocumentProcessor();
  const registry = createRunnerRegistry({
    providerIO,
    variants,
    scanner,
    image,
    video,
    document,
  });
  return { providerIO, variants, scanner, image, video, document, registry };
}

describe('createRunnerRegistry', () => {
  test('exposes a runner for EVERY processing job type the planner can emit', () => {
    const { registry } = build();
    for (const jobType of PROCESSING_JOB_TYPES) {
      expect(typeof registry[jobType as ProcessingJobType]).toBe('function');
    }
  });

  test('is frozen so callers cannot accidentally swap runners at runtime', () => {
    const { registry } = build();
    expect(() => {
      (registry as { scan_validation?: unknown }).scan_validation = undefined;
    }).toThrow();
  });

  test('scan_validation runner returns {} for a clean image', async () => {
    const { providerIO, registry } = build();
    const object = seedImageObject();
    providerIO.preload(object.providerObjectKey, makeBytes(8));
    const fn = registry.scan_validation;
    if (!fn) throw new Error('scan_validation runner missing');
    const out = await fn({ object, job: seedClaimedJob({ jobType: 'scan_validation' }) });
    expect(out).toEqual({});
  });

  test('image_optimize runner produces variants', async () => {
    const { providerIO, variants, registry } = build();
    const object = seedImageObject();
    providerIO.preload(object.providerObjectKey, makeBytes(8));
    const fn = registry.image_optimize;
    if (!fn) throw new Error('image_optimize runner missing');
    await fn({ object, job: seedClaimedJob({ jobType: 'image_optimize' }) });
    expect(variants.records.length).toBeGreaterThan(0);
  });

  test('video_probe runner returns {} for a normal-sized clip', async () => {
    const { providerIO, registry } = build();
    const object = seedVideoObject();
    providerIO.preload(object.providerObjectKey, makeBytes(8));
    const fn = registry.video_probe;
    if (!fn) throw new Error('video_probe runner missing');
    const out = await fn({ object, job: seedClaimedJob({ jobType: 'video_probe' }) });
    expect(out).toEqual({});
  });

  test('video_thumbnail runner produces a poster variant', async () => {
    const { providerIO, variants, registry } = build();
    const object = seedVideoObject();
    providerIO.preload(object.providerObjectKey, makeBytes(8));
    const fn = registry.video_thumbnail;
    if (!fn) throw new Error('video_thumbnail runner missing');
    await fn({ object, job: seedClaimedJob({ jobType: 'video_thumbnail' }) });
    expect(variants.records.map((r) => r.role)).toEqual(['poster']);
  });

  test('video_transcode runner produces a transcode_h264 variant', async () => {
    const { providerIO, variants, registry } = build();
    const object = seedVideoObject();
    providerIO.preload(object.providerObjectKey, makeBytes(8));
    const fn = registry.video_transcode;
    if (!fn) throw new Error('video_transcode runner missing');
    await fn({ object, job: seedClaimedJob({ jobType: 'video_transcode' }) });
    expect(variants.records.map((r) => r.role)).toEqual(['transcode_h264']);
  });

  test('document_preview runner produces a preview_first_page variant', async () => {
    const { providerIO, variants, registry } = build();
    const object = seedDocumentObject();
    providerIO.preload(object.providerObjectKey, makeBytes(8));
    const fn = registry.document_preview;
    if (!fn) throw new Error('document_preview runner missing');
    await fn({ object, job: seedClaimedJob({ jobType: 'document_preview' }) });
    expect(variants.records.map((r) => r.role)).toEqual(['preview_first_page']);
  });
});

describe('noopMalwareScanner', () => {
  test('always returns clean', async () => {
    const { noopMalwareScanner } =
      await import('../../../../../src/actions/handlers/processing/runners/ports');
    const out = await noopMalwareScanner.scan({ bytes: new Uint8Array([1, 2, 3]) });
    expect(out).toEqual({ verdict: 'clean' });
  });
});
