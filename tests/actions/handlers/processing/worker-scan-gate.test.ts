import { describe, expect, test } from 'bun:test';
import { ProcessingWorker } from '../../../../src/actions/handlers/processing/worker';
import type {
  JobRunner,
  ProcessingJobType,
} from '../../../../src/actions/handlers/processing/types';
import { FakeObjectStatus, FakeProcessingQueue, seedObject } from './_fakes';

function wiring(
  scanStatus?: 'succeeded' | 'queued' | 'running' | 'failed' | 'cancelled',
  jobType: ProcessingJobType = 'image_optimize',
) {
  const queue = new FakeProcessingQueue();
  const status = new FakeObjectStatus();
  const object = seedObject({ status: 'processing' });
  status.seed(object);
  queue.bindObjectToWorkspace(object.id, object.workspaceId);
  const now = () => new Date('2026-09-30T00:00:00Z');
  if (scanStatus)
    queue.seed({
      id: 'scan',
      objectId: object.id,
      jobType: 'scan_validation',
      status: scanStatus,
      required: true,
      scheduledAt: new Date('2026-10-01T00:00:00Z'),
    });
  queue.seed({ id: 'native', objectId: object.id, jobType, required: jobType === 'video_probe' });
  let nativeCalls = 0;
  const native: JobRunner = async () => {
    nativeCalls += 1;
  };
  const worker = new ProcessingWorker({
    queue,
    status,
    now,
    findObject: async (input) =>
      input.workspaceId === object.workspaceId
        ? (status.objects.get(input.objectId) ?? null)
        : null,
    runners: { [jobType]: native },
  });
  return { queue, status, object, worker, nativeCalls: () => nativeCalls };
}

describe('XYN-SEC-001 worker scan gate', () => {
  test.each([
    'image_optimize',
    'video_probe',
    'video_thumbnail',
    'video_transcode',
    'document_preview',
  ] as const)('%s cannot run without scan evidence', async (jobType) => {
    const flow = wiring(undefined, jobType);
    await flow.worker.runOnce();
    expect(flow.nativeCalls()).toBe(0);
    expect(flow.queue.getRow('native')?.errorCode).toBe('SCAN_NOT_PASSED');
    expect(flow.status.objects.get(flow.object.id)?.status).toBe('failed');
    expect(flow.status.calls.some((call) => call.nextStatus === 'ready')).toBe(false);
  });
  test.each(['queued', 'running'] as const)(
    '%s scan defers decoding without burning attempts',
    async (scanStatus) => {
      const flow = wiring(scanStatus);
      const stats = await flow.worker.runOnce();
      expect(stats).toMatchObject({ skipped: 1, attempted: 0 });
      expect(flow.nativeCalls()).toBe(0);
      expect(flow.queue.getRow('native')).toMatchObject({
        status: 'queued',
        attempts: 0,
        errorCode: null,
      });
    },
  );
  test.each(['failed', 'cancelled'] as const)(
    '%s scan quarantines a native job',
    async (scanStatus) => {
      const flow = wiring(scanStatus);
      await flow.worker.runOnce();
      expect(flow.nativeCalls()).toBe(0);
      expect(flow.queue.getRow('native')).toMatchObject({
        status: 'failed',
        errorCode: 'SCAN_NOT_PASSED',
      });
    },
  );
  test('successful scan permits native processing', async () => {
    const flow = wiring('succeeded');
    expect((await flow.worker.runOnce()).succeeded).toBe(1);
    expect(flow.nativeCalls()).toBe(1);
  });
  test('a scan lookup outage never falls through to the native runner', async () => {
    const flow = wiring('succeeded');
    flow.queue.listForObject = async () => {
      throw new Error('fixture DB unavailable');
    };
    expect((await flow.worker.runOnce()).retried).toBe(1);
    expect(flow.nativeCalls()).toBe(0);
    expect(flow.queue.getRow('native')?.errorCode).toBe('SCAN_STATE_UNAVAILABLE');
  });
  test('scan-first execution works even when a native job is claimed first', async () => {
    const flow = wiring();
    flow.queue.seed({
      id: 'scan',
      objectId: flow.object.id,
      jobType: 'scan_validation',
      required: true,
    });
    const worker = new ProcessingWorker({
      queue: flow.queue,
      status: flow.status,
      findObject: async () => flow.object,
      runners: {
        scan_validation: async () => {
          expect(flow.nativeCalls()).toBe(0);
        },
        image_optimize: async () => {
          expect(flow.queue.getRow('scan')?.status).toBe('succeeded');
        },
      },
      maxConcurrentPerWorkspace: 4,
    });
    expect((await worker.runOnce()).succeeded).toBe(2);
  });

  test('a scan owned by another worker must finish before native parsing starts', async () => {
    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    const object = seedObject({ status: 'processing' });
    status.seed(object);
    queue.bindObjectToWorkspace(object.id, object.workspaceId);
    queue.seed({ id: 'scan', objectId: object.id, jobType: 'scan_validation', required: true });
    queue.seed({ id: 'native', objectId: object.id, jobType: 'image_optimize' });
    let releaseScan: () => void = () => {};
    let signalStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const scanComplete = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    let calls = 0;
    let time = Date.parse('2026-09-30T00:00:00Z');
    const deps = {
      queue,
      status,
      now: () => new Date(time),
      maxConcurrent: 1,
      findObject: async () => object,
      runners: {
        scan_validation: async () => {
          signalStarted();
          await scanComplete;
        },
        image_optimize: async () => {
          calls += 1;
        },
      },
    };
    const scanning = new ProcessingWorker(deps).runOnce();
    await started;
    const otherWorker = new ProcessingWorker(deps);
    try {
      expect((await otherWorker.runOnce()).skipped).toBe(1);
      expect(calls).toBe(0);
      expect(queue.getRow('native')).toMatchObject({ status: 'queued', attempts: 0 });
    } finally {
      releaseScan();
    }
    await scanning;
    time += 2000;
    expect((await otherWorker.runOnce()).succeeded).toBe(1);
    expect(calls).toBe(1);
  });

  test('a foreign workspace object cannot authorize native processing', async () => {
    const flow = wiring('succeeded');
    let queried = false;
    flow.queue.listForObject = async () => {
      queried = true;
      return [];
    };
    const worker = new ProcessingWorker({
      queue: flow.queue,
      status: flow.status,
      findObject: async () => ({ ...flow.object, workspaceId: 'other-workspace' }),
      runners: {
        image_optimize: async () => {
          throw new Error('must not run');
        },
      },
    });
    expect((await worker.runOnce()).failed).toBe(1);
    expect(flow.queue.getRow('native')?.errorCode).toBe('OBJECT_NOT_AVAILABLE');
    expect(queried).toBe(false);
  });
});
