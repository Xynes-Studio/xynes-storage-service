/**
 * STORAGE-7 — worker engine tests.
 *
 * Covers:
 *   - Happy path success + parent aggregate flip to ready
 *   - Retryable failure -> requeue with backoff (attempts < maxAttempts)
 *   - Retryable failure at maxAttempts -> terminal failed + parent failed
 *     (required job)
 *   - Non-retryable failure -> terminal failed immediately
 *   - Required vs non-required terminal failure -> aggregate posture
 *   - Runner missing -> RUNNER_MISSING handling (retried-then-terminal)
 *   - Runner throws -> RUNNER_THREW (retryable)
 *   - Parent object deleted between claim and run -> cancel job
 *   - Per-workspace concurrency cap -> skip + requeue with tiny backoff
 *   - Global concurrency cap honoured
 *   - Empty queue is a no-op
 *   - start/stop polling loop
 *   - swallows runOnce errors inside polling loop
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import {
  ProcessingWorker,
  noopScanValidationRunner,
} from '../../../../src/actions/handlers/processing/worker';
import type {
  JobRunner,
  ProcessingJobType,
} from '../../../../src/actions/handlers/processing/types';
import {
  FakeObjectStatus,
  FakeProcessingQueue,
  TEST_WORKSPACE_ID,
  makeFindObject,
  resetIds,
  seedObject,
} from './_fakes';

const successRunner: JobRunner = async () => ({});
const failingRunner: (code: string, retryable?: boolean) => JobRunner =
  (code, retryable = true) =>
  async () => ({ errorCode: code, retryable });
const throwingRunner: JobRunner = async () => {
  throw new Error('boom');
};

beforeEach(() => {
  resetIds();
});

describe('ProcessingWorker — happy paths', () => {
  test('drains an empty queue without touching anything', async () => {
    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    const worker = new ProcessingWorker({
      queue,
      status,
      findObject: makeFindObject(status),
      runners: { scan_validation: noopScanValidationRunner },
    });
    const stats = await worker.runOnce();
    expect(stats.attempted).toBe(0);
    expect(queue.claimNextCount).toBe(1); // tried once, got null
  });

  test('runs a single succeeded job and flips parent to ready', async () => {
    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    const o = seedObject({ contentType: 'image/jpeg', status: 'processing' });
    status.seed(o);
    queue.bindObjectToWorkspace(o.id, o.workspaceId);
    queue.seed({
      id: 'j-1',
      objectId: o.id,
      jobType: 'scan_validation',
      required: true,
      status: 'queued',
    });
    const worker = new ProcessingWorker({
      queue,
      status,
      findObject: makeFindObject(status),
      runners: { scan_validation: successRunner },
    });
    const stats = await worker.runOnce();
    expect(stats.succeeded).toBe(1);
    expect(queue.getRow('j-1')?.status).toBe('succeeded');
    expect(status.objects.get(o.id)?.status).toBe('ready');
  });

  test('multiple succeeded required jobs all flip parent to ready exactly once at the end', async () => {
    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    const o = seedObject({ status: 'processing' });
    status.seed(o);
    queue.bindObjectToWorkspace(o.id, o.workspaceId);
    queue.seed({ id: 'j-a', objectId: o.id, jobType: 'scan_validation', required: true });
    queue.seed({ id: 'j-b', objectId: o.id, jobType: 'video_probe', required: true });
    const worker = new ProcessingWorker({
      queue,
      status,
      findObject: makeFindObject(status),
      runners: { scan_validation: successRunner, video_probe: successRunner },
      maxConcurrentPerWorkspace: 2,
    });
    await worker.runOnce();
    expect(queue.getRow('j-a')?.status).toBe('succeeded');
    expect(queue.getRow('j-b')?.status).toBe('succeeded');
    expect(status.objects.get(o.id)?.status).toBe('ready');
  });

  test('one succeeded + one queued -> aggregate stays processing', async () => {
    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    const o = seedObject({ status: 'processing' });
    status.seed(o);
    queue.bindObjectToWorkspace(o.id, o.workspaceId);
    queue.seed({ id: 'j-a', objectId: o.id, jobType: 'scan_validation', required: true });
    queue.seed({ id: 'j-b', objectId: o.id, jobType: 'video_probe', required: true });
    const worker = new ProcessingWorker({
      queue,
      status,
      findObject: makeFindObject(status),
      runners: {
        scan_validation: successRunner,
        // No video_probe runner -> RUNNER_MISSING -> retried then we stop the test before terminal
      },
      maxConcurrent: 1, // Only handles `j-a` per call
      maxConcurrentPerWorkspace: 1,
    });
    await worker.runOnce();
    // j-a succeeded, j-b still queued -> aggregate stays 'processing'
    expect(queue.getRow('j-a')?.status).toBe('succeeded');
    expect(queue.getRow('j-b')?.status).toBe('queued');
    expect(status.objects.get(o.id)?.status).toBe('processing');
  });
});

describe('ProcessingWorker — failures', () => {
  test('retryable runner-error below maxAttempts -> requeued with backoff', async () => {
    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    const o = seedObject({ status: 'processing' });
    status.seed(o);
    queue.bindObjectToWorkspace(o.id, o.workspaceId);
    queue.seed({
      id: 'j-1',
      objectId: o.id,
      jobType: 'scan_validation',
      required: true,
      maxAttempts: 3,
    });
    const fixedNow = new Date('2026-05-14T03:00:00.000Z');
    const worker = new ProcessingWorker({
      queue,
      status,
      findObject: makeFindObject(status),
      runners: { scan_validation: failingRunner('RUNNER_FAILED', true) },
      maxAttempts: 3,
      retryBackoffSeconds: 60,
      now: () => fixedNow,
    });
    const stats = await worker.runOnce();
    expect(stats.retried).toBe(1);
    const row = queue.getRow('j-1');
    expect(row?.status).toBe('queued');
    expect(row?.errorCode).toBe('RUNNER_FAILED');
    expect(row?.scheduledAt.toISOString()).toBe('2026-05-14T03:01:00.000Z');
  });

  test('non-retryable runner-error -> terminal failed and aggregate flips when required', async () => {
    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    const o = seedObject({ status: 'processing' });
    status.seed(o);
    queue.bindObjectToWorkspace(o.id, o.workspaceId);
    queue.seed({ id: 'j-1', objectId: o.id, jobType: 'scan_validation', required: true });
    const worker = new ProcessingWorker({
      queue,
      status,
      findObject: makeFindObject(status),
      runners: { scan_validation: failingRunner('UNSUPPORTED', false) },
    });
    await worker.runOnce();
    expect(queue.getRow('j-1')?.status).toBe('failed');
    expect(status.objects.get(o.id)?.status).toBe('failed');
  });

  test('non-required terminal failure does NOT flip parent to failed', async () => {
    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    const o = seedObject({ status: 'processing' });
    status.seed(o);
    queue.bindObjectToWorkspace(o.id, o.workspaceId);
    queue.seed({
      id: 'j-required',
      objectId: o.id,
      jobType: 'scan_validation',
      required: true,
      status: 'succeeded',
    });
    queue.seed({
      id: 'j-soft',
      objectId: o.id,
      jobType: 'image_optimize',
      required: false,
    });
    const worker = new ProcessingWorker({
      queue,
      status,
      findObject: makeFindObject(status),
      runners: { image_optimize: failingRunner('UNSUPPORTED', false) },
    });
    await worker.runOnce();
    expect(queue.getRow('j-soft')?.status).toBe('failed');
    // Required succeeded + soft failed -> aggregate ready
    expect(status.objects.get(o.id)?.status).toBe('ready');
  });

  test('runner THROWING -> RUNNER_THREW (retryable)', async () => {
    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    const o = seedObject({ status: 'processing' });
    status.seed(o);
    queue.bindObjectToWorkspace(o.id, o.workspaceId);
    queue.seed({ id: 'j-1', objectId: o.id, jobType: 'scan_validation', required: true });
    const worker = new ProcessingWorker({
      queue,
      status,
      findObject: makeFindObject(status),
      runners: { scan_validation: throwingRunner },
      maxAttempts: 3,
    });
    await worker.runOnce();
    const row = queue.getRow('j-1');
    expect(row?.status).toBe('queued');
    expect(row?.errorCode).toBe('RUNNER_THREW');
    expect(row?.attempts).toBe(1);
  });

  test('runner missing -> RUNNER_MISSING (retryable, fails after maxAttempts)', async () => {
    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    const o = seedObject({ status: 'processing' });
    status.seed(o);
    queue.bindObjectToWorkspace(o.id, o.workspaceId);
    queue.seed({
      id: 'j-1',
      objectId: o.id,
      jobType: 'scan_validation',
      required: true,
      attempts: 2, // next attempt will be 3 == maxAttempts
    });
    const worker = new ProcessingWorker({
      queue,
      status,
      findObject: makeFindObject(status),
      runners: {}, // None registered
      maxAttempts: 3,
    });
    await worker.runOnce();
    const row = queue.getRow('j-1');
    expect(row?.status).toBe('failed');
    expect(row?.errorCode).toBe('RUNNER_MISSING');
    expect(status.objects.get(o.id)?.status).toBe('failed');
  });

  test('parent object deleted -> cancel job (terminal), do NOT touch aggregate', async () => {
    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    const o = seedObject({ status: 'deleted' });
    status.seed(o);
    queue.bindObjectToWorkspace(o.id, o.workspaceId);
    queue.seed({ id: 'j-1', objectId: o.id, jobType: 'scan_validation', required: true });
    const worker = new ProcessingWorker({
      queue,
      status,
      findObject: makeFindObject(status),
      runners: { scan_validation: successRunner },
    });
    await worker.runOnce();
    expect(queue.getRow('j-1')?.status).toBe('failed');
    expect(queue.getRow('j-1')?.errorCode).toBe('OBJECT_NOT_AVAILABLE');
    // Status not modified — the object stays 'deleted'
    expect(status.objects.get(o.id)?.status).toBe('deleted');
    expect(status.calls).toEqual([]);
  });

  test('parent object missing -> cancel job (treated as deleted)', async () => {
    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    // No object seeded
    queue.bindObjectToWorkspace('nonexistent', TEST_WORKSPACE_ID);
    queue.seed({ id: 'j-1', objectId: 'nonexistent', jobType: 'scan_validation', required: true });
    const worker = new ProcessingWorker({
      queue,
      status,
      findObject: makeFindObject(status),
      runners: { scan_validation: successRunner },
    });
    await worker.runOnce();
    expect(queue.getRow('j-1')?.status).toBe('failed');
    expect(queue.getRow('j-1')?.errorCode).toBe('OBJECT_NOT_AVAILABLE');
  });
});

describe('ProcessingWorker — concurrency limits', () => {
  test('honours maxConcurrent across the whole worker', async () => {
    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    // 5 objects across 5 workspaces (so per-workspace cap doesn't kick in)
    for (let i = 0; i < 5; i += 1) {
      const ws = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      const o = seedObject({ workspaceId: ws, status: 'processing' });
      status.seed(o);
      queue.bindObjectToWorkspace(o.id, ws);
      queue.seed({ id: `j-${i}`, objectId: o.id, jobType: 'scan_validation', required: true });
    }
    const worker = new ProcessingWorker({
      queue,
      status,
      findObject: makeFindObject(status),
      runners: { scan_validation: successRunner },
      maxConcurrent: 2,
    });
    const stats = await worker.runOnce();
    expect(stats.attempted).toBe(2);
    // 3 still queued
    const stillQueued = queue.snapshot().filter((r) => r.status === 'queued');
    expect(stillQueued.length).toBe(3);
  });

  test('per-workspace cap skips additional claims from the same workspace and requeues them', async () => {
    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    const o = seedObject({ status: 'processing' });
    status.seed(o);
    queue.bindObjectToWorkspace(o.id, o.workspaceId);
    // 3 jobs same workspace, per-workspace cap = 1
    queue.seed({ id: 'j-1', objectId: o.id, jobType: 'scan_validation', required: true });
    queue.seed({
      id: 'j-2',
      objectId: o.id,
      jobType: 'video_probe',
      required: true,
      scheduledAt: new Date('2026-05-14T01:00:01.000Z'),
    });
    queue.seed({
      id: 'j-3',
      objectId: o.id,
      jobType: 'video_thumbnail',
      required: false,
      scheduledAt: new Date('2026-05-14T01:00:02.000Z'),
    });
    const worker = new ProcessingWorker({
      queue,
      status,
      findObject: makeFindObject(status),
      runners: {
        scan_validation: successRunner,
        video_probe: successRunner,
        video_thumbnail: successRunner,
      },
      maxConcurrent: 4,
      maxConcurrentPerWorkspace: 1,
      now: () => new Date('2026-05-14T01:00:10.000Z'),
    });
    const stats = await worker.runOnce();
    // Only 1 from this workspace runs; the other 2 should be skip+requeue
    expect(stats.attempted).toBe(1);
    expect(stats.skipped).toBe(2);
    // Skipped ones are still in queued state with PER_WORKSPACE_CAP errorCode
    const j2 = queue.getRow('j-2');
    const j3 = queue.getRow('j-3');
    expect([j2?.errorCode, j3?.errorCode]).toContain('PER_WORKSPACE_CAP');
    expect([j2?.status, j3?.status]).toEqual(['queued', 'queued']);
  });
});

describe('ProcessingWorker — polling loop', () => {
  test('start/stop are idempotent and stop halts the loop', async () => {
    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    const worker = new ProcessingWorker({
      queue,
      status,
      findObject: makeFindObject(status),
      runners: {},
    });
    worker.start(10);
    worker.start(10); // second call is a no-op
    await new Promise((r) => setTimeout(r, 30));
    worker.stop();
    worker.stop(); // second stop is a no-op
    const callsAfterStop = queue.claimNextCount;
    await new Promise((r) => setTimeout(r, 30));
    expect(queue.claimNextCount).toBe(callsAfterStop);
  });

  test('polling loop swallows runOnce errors and keeps running', async () => {
    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    queue.throwOnClaim = true;
    const worker = new ProcessingWorker({
      queue,
      status,
      findObject: makeFindObject(status),
      runners: {},
    });
    worker.start(10);
    await new Promise((r) => setTimeout(r, 40));
    worker.stop();
    expect(queue.claimNextCount).toBeGreaterThan(0);
  });
});

describe('ProcessingWorker — defaults + misc', () => {
  test('runs with default maxConcurrent/maxAttempts/backoff/now when not provided', async () => {
    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    const o = seedObject({ status: 'processing' });
    status.seed(o);
    queue.bindObjectToWorkspace(o.id, o.workspaceId);
    queue.seed({ id: 'j-d', objectId: o.id, jobType: 'scan_validation', required: true });
    const worker = new ProcessingWorker({
      queue,
      status,
      findObject: makeFindObject(status),
      runners: { scan_validation: successRunner },
    });
    const stats = await worker.runOnce();
    expect(stats.succeeded).toBe(1);
  });

  test('noopScanValidationRunner returns OK', async () => {
    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    const o = seedObject({ status: 'processing' });
    status.seed(o);
    queue.bindObjectToWorkspace(o.id, o.workspaceId);
    queue.seed({ id: 'j-noop', objectId: o.id, jobType: 'scan_validation', required: true });
    const worker = new ProcessingWorker({
      queue,
      status,
      findObject: makeFindObject(status),
      runners: { scan_validation: noopScanValidationRunner },
    });
    const stats = await worker.runOnce();
    expect(stats.succeeded).toBe(1);
  });

  test('runner returning bare null/undefined is treated as success', async () => {
    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    const o = seedObject({ status: 'processing' });
    status.seed(o);
    queue.bindObjectToWorkspace(o.id, o.workspaceId);
    queue.seed({ id: 'j-bare', objectId: o.id, jobType: 'scan_validation', required: true });
    const runner: JobRunner = async () => undefined;
    const worker = new ProcessingWorker({
      queue,
      status,
      findObject: makeFindObject(status),
      runners: { scan_validation: runner },
    });
    const stats = await worker.runOnce();
    expect(stats.succeeded).toBe(1);
  });

  test('jobs scheduled in the future are not claimed', async () => {
    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    const o = seedObject({ status: 'processing' });
    status.seed(o);
    queue.bindObjectToWorkspace(o.id, o.workspaceId);
    queue.seed({
      id: 'j-future',
      objectId: o.id,
      jobType: 'scan_validation',
      required: true,
      scheduledAt: new Date('2030-01-01T00:00:00.000Z'),
    });
    const worker = new ProcessingWorker({
      queue,
      status,
      findObject: makeFindObject(status),
      runners: { scan_validation: successRunner },
      now: () => new Date('2026-05-14T03:00:00.000Z'),
    });
    const stats = await worker.runOnce();
    expect(stats.attempted).toBe(0);
    expect(queue.getRow('j-future')?.status).toBe('queued');
  });

  test('runners registry only used types declared in PROCESSING_JOB_TYPES are honored', async () => {
    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    const o = seedObject({ status: 'processing' });
    status.seed(o);
    queue.bindObjectToWorkspace(o.id, o.workspaceId);
    queue.seed({
      id: 'j-x',
      objectId: o.id,
      jobType: 'unknown_type' as ProcessingJobType,
      required: false,
      attempts: 2,
    });
    const worker = new ProcessingWorker({
      queue,
      status,
      findObject: makeFindObject(status),
      runners: {},
      maxAttempts: 3,
    });
    await worker.runOnce();
    expect(queue.getRow('j-x')?.status).toBe('failed');
    expect(queue.getRow('j-x')?.errorCode).toBe('RUNNER_MISSING');
  });
});
