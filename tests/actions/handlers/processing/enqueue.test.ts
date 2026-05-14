/**
 * STORAGE-7 — enqueueProcessingForObject tests.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { enqueueProcessingForObject } from '../../../../src/actions/handlers/processing/enqueue';
import {
  FakeObjectStatus,
  FakeProcessingQueue,
  TEST_WORKSPACE_ID,
  resetIds,
  seedObject,
} from './_fakes';

let idx = 0;
const nextId = () => {
  idx += 1;
  return `00000000-0000-4000-8000-3000${String(idx).padStart(8, '0')}`;
};

beforeEach(() => {
  resetIds();
  idx = 0;
});

describe('enqueueProcessingForObject', () => {
  test('skips when planner returns no jobs (non-uploaded object)', async () => {
    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    const o = seedObject({ status: 'pending_upload' });
    const result = await enqueueProcessingForObject(
      { queue, status, idFactory: nextId, now: () => new Date('2026-05-14T01:00:00.000Z') },
      o,
    );
    expect(result.jobs).toEqual([]);
    expect(result.object).toBeNull();
    expect(queue.enqueueBatchCount).toBe(0);
    expect(status.calls).toEqual([]);
  });

  test('plans + inserts jobs in one batch + flips parent to processing', async () => {
    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    const o = seedObject({ contentType: 'image/jpeg', compressionRequested: true });
    status.seed(o);
    const result = await enqueueProcessingForObject(
      { queue, status, idFactory: nextId, now: () => new Date('2026-05-14T01:00:00.000Z') },
      o,
    );
    expect(result.jobs).toHaveLength(2); // scan + image_optimize
    const types = result.jobs.map((j) => j.jobType).sort();
    expect(types).toEqual(['image_optimize', 'scan_validation']);
    expect(queue.enqueueBatchCount).toBe(1);
    expect(status.calls).toEqual([
      { objectId: o.id, workspaceId: TEST_WORKSPACE_ID, nextStatus: 'processing' },
    ]);
    expect(status.objects.get(o.id)?.status).toBe('processing');
  });

  test('inserts video jobs in plan order', async () => {
    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    const o = seedObject({ contentType: 'video/mp4', compressionRequested: true });
    status.seed(o);
    const result = await enqueueProcessingForObject({ queue, status, idFactory: nextId }, o);
    expect(result.jobs.map((j) => j.jobType)).toEqual([
      'scan_validation',
      'video_probe',
      'video_thumbnail',
      'video_transcode',
    ]);
  });

  test('returns null object when status repo cannot find the row (deleted)', async () => {
    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    // Don't seed -> status.updateAggregateStatus returns null
    const o = seedObject({ contentType: 'image/png' });
    const result = await enqueueProcessingForObject({ queue, status, idFactory: nextId }, o);
    expect(result.jobs).toHaveLength(2);
    expect(result.object).toBeNull();
  });

  test('queue insert failure bubbles up — caller decides what to do', async () => {
    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    queue.seed({
      id: 'preexisting',
      objectId: 'will-collide',
      jobType: 'scan_validation',
      status: 'queued',
      required: true,
    });
    const o = seedObject({ id: 'will-collide', contentType: 'image/jpeg' });
    status.seed(o);
    await expect(
      enqueueProcessingForObject({ queue, status, idFactory: nextId }, o),
    ).rejects.toThrow();
  });

  test('uses deps.now and deps.idFactory deterministically', async () => {
    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    const o = seedObject({ contentType: 'image/jpeg' });
    status.seed(o);
    const fixedNow = new Date('2026-05-14T02:00:00.000Z');
    let i = 0;
    const ids = ['jid-0', 'jid-1'];
    const result = await enqueueProcessingForObject(
      { queue, status, idFactory: () => ids[i++]!, now: () => fixedNow },
      o,
    );
    expect(result.jobs.map((j) => j.id)).toEqual(['jid-0', 'jid-1']);
    for (const j of result.jobs) {
      expect(j.scheduledAt.toISOString()).toBe('2026-05-14T02:00:00.000Z');
    }
  });

  test('jobs are queued with attempts=0 and errorCode=null', async () => {
    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    const o = seedObject({ contentType: 'image/jpeg' });
    status.seed(o);
    const result = await enqueueProcessingForObject({ queue, status, idFactory: nextId }, o);
    for (const j of result.jobs) {
      expect(j.status).toBe('queued');
      expect(j.attempts).toBe(0);
      expect(j.errorCode).toBeNull();
    }
  });

  test('falls back to default idFactory + now when not provided', async () => {
    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    const o = seedObject({ contentType: 'image/jpeg' });
    status.seed(o);
    const result = await enqueueProcessingForObject({ queue, status }, o);
    expect(result.jobs).toHaveLength(2);
    for (const j of result.jobs) {
      // Should be valid UUID-shaped id from crypto.randomUUID()
      expect(j.id).toMatch(/^[0-9a-f-]{36}$/i);
    }
  });
});
