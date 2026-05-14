/**
 * STORAGE-8 — end-to-end worker integration test.
 *
 * Proves the STORAGE-7 `ProcessingWorker` + STORAGE-7 `enqueueProcessingForObject`
 * + STORAGE-8 `createRunnerRegistry` chain works without any production-Drizzle
 * pieces wired in. This is the closest we can get in unit tests to the
 * production data flow.
 *
 * Flow under test:
 *   1. Plan jobs for an uploaded image via `enqueueProcessingForObject`.
 *   2. Worker claims & runs each job using the STORAGE-8 registry.
 *   3. Variants land in the variant writer.
 *   4. Parent object flips from `processing` -> `ready` via the
 *      STORAGE-7 aggregator.
 */
import { describe, expect, test } from 'bun:test';
import { enqueueProcessingForObject } from '../../../../../src/actions/handlers/processing/enqueue';
import { ProcessingWorker } from '../../../../../src/actions/handlers/processing/worker';
import { createRunnerRegistry } from '../../../../../src/actions/handlers/processing/runners/registry';
import { FakeObjectStatus, FakeProcessingQueue, seedObject } from '../_fakes';
import {
  FakeDocumentProcessor,
  FakeImageProcessor,
  FakeMalwareScanner,
  FakeProviderIO,
  FakeVariantWriter,
  FakeVideoProcessor,
  makeBytes,
  seedImageObject,
  seedVideoObject,
} from './_fakes';

function buildWiring() {
  const queue = new FakeProcessingQueue();
  const status = new FakeObjectStatus();
  const providerIO = new FakeProviderIO();
  const variants = new FakeVariantWriter();
  const scanner = new FakeMalwareScanner();
  const image = new FakeImageProcessor();
  const video = new FakeVideoProcessor();
  const document = new FakeDocumentProcessor();
  const runners = createRunnerRegistry({
    providerIO,
    variants,
    scanner,
    image,
    video,
    document,
  });
  return { queue, status, providerIO, variants, runners, image, video };
}

describe('end-to-end: planner + worker + registry (STORAGE-7 ∘ STORAGE-8)', () => {
  test('image upload runs scan + image_optimize end-to-end, parent ends ready', async () => {
    const { queue, status, providerIO, variants, runners } = buildWiring();
    const object = seedImageObject();
    providerIO.preload(object.providerObjectKey, makeBytes(64), 'image/jpeg');

    await enqueueProcessingForObject(
      {
        queue,
        status,
        now: () => new Date('2026-05-14T01:00:00.000Z'),
        idFactory: () => `job-${queue.enqueueBatchCount}-${Math.random().toString(36).slice(2)}`,
      },
      object,
    );

    const worker = new ProcessingWorker({
      queue,
      status,
      findObject: async () => object,
      runners,
      now: () => new Date('2026-05-14T01:00:01.000Z'),
      maxConcurrent: 4,
      maxConcurrentPerWorkspace: 4,
      maxAttempts: 3,
      retryBackoffSeconds: 60,
    });

    // Two planned jobs: scan_validation + image_optimize.
    const first = await worker.runOnce();
    expect(first.attempted).toBeGreaterThan(0);

    // Parent should be `ready` once scan_validation has succeeded
    // (image_optimize is non-required, but in this test it also succeeds).
    expect(status.calls.length).toBeGreaterThan(0);
    const last = status.calls.at(-1);
    expect(last?.nextStatus).toBe('ready');

    // Variants from image_optimize landed.
    expect(variants.records.length).toBeGreaterThan(0);
  });

  test('video upload runs scan + probe + thumbnail + transcode and ends ready', async () => {
    const { queue, status, providerIO, variants, runners } = buildWiring();
    const object = seedVideoObject();
    providerIO.preload(object.providerObjectKey, makeBytes(64), 'video/mp4');

    await enqueueProcessingForObject(
      {
        queue,
        status,
        now: () => new Date('2026-05-14T01:00:00.000Z'),
        idFactory: () => `job-${Math.random().toString(36).slice(2)}`,
      },
      object,
    );

    const worker = new ProcessingWorker({
      queue,
      status,
      findObject: async () => object,
      runners,
      now: () => new Date('2026-05-14T01:00:01.000Z'),
      maxConcurrent: 4,
      maxConcurrentPerWorkspace: 4,
    });

    // Drain in case multiple runOnce iterations are needed.
    for (let i = 0; i < 5; i += 1) {
      const stats = await worker.runOnce();
      if (stats.attempted === 0) break;
    }

    expect(status.calls.at(-1)?.nextStatus).toBe('ready');
    // poster + transcode_h264.
    const roles = variants.records.map((r) => r.role).sort();
    expect(roles).toEqual(['poster', 'transcode_h264']);
  });

  test('over-cap image rejects via scan_validation (required) — parent ends failed', async () => {
    const { queue, status, providerIO, runners } = buildWiring();
    const object = seedObject({
      contentType: 'image/jpeg',
      byteSize: 60 * 1024 * 1024, // > 50 MiB cap
      compressionRequested: true,
    });
    providerIO.preload(object.providerObjectKey, makeBytes(16));

    await enqueueProcessingForObject(
      {
        queue,
        status,
        now: () => new Date('2026-05-14T01:00:00.000Z'),
        idFactory: () => `job-${Math.random().toString(36).slice(2)}`,
      },
      object,
    );

    const worker = new ProcessingWorker({
      queue,
      status,
      findObject: async () => object,
      runners,
      now: () => new Date('2026-05-14T01:00:01.000Z'),
      maxConcurrent: 4,
      maxConcurrentPerWorkspace: 4,
      // Non-retryable error -> single attempt is enough.
      maxAttempts: 3,
    });

    for (let i = 0; i < 5; i += 1) {
      const stats = await worker.runOnce();
      if (stats.attempted === 0) break;
    }

    expect(status.calls.at(-1)?.nextStatus).toBe('failed');
  });
});
