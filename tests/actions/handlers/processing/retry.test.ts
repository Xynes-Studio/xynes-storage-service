/**
 * STORAGE-7 — retry handler tests.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { createRetryProcessingHandler } from '../../../../src/actions/handlers/processing/retry';
import { ValidationError } from '../../../../src/actions/errors';
import {
  FakeObjectStatus,
  FakeProcessingQueue,
  TEST_WORKSPACE_ID,
  makeApiKeyCtx,
  makeUserCtx,
  resetIds,
  seedObject,
} from './_fakes';
import type { StorageObjectRecord } from '../../../../src/actions/handlers/objects/types';

function objectRepoOf(status: FakeObjectStatus) {
  return {
    findByIdForWorkspace: async (input: { objectId: string; workspaceId: string }) => {
      const o = status.objects.get(input.objectId);
      if (!o || o.workspaceId !== input.workspaceId) return null;
      return o;
    },
  };
}

const validId = '00000000-0000-4000-8000-100000000099';

beforeEach(() => {
  resetIds();
});

describe('createRetryProcessingHandler — happy paths', () => {
  test('requeues all failed jobs for an object and flips parent to processing', async () => {
    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    const o = seedObject({ id: validId, status: 'failed' });
    status.seed(o);
    queue.bindObjectToWorkspace(o.id, o.workspaceId);
    queue.seed({
      id: 'j-1',
      objectId: o.id,
      jobType: 'scan_validation',
      required: true,
      status: 'failed',
      errorCode: 'X',
      attempts: 3,
    });
    queue.seed({
      id: 'j-2',
      objectId: o.id,
      jobType: 'image_optimize',
      required: false,
      status: 'failed',
      errorCode: 'Y',
      attempts: 3,
    });
    const handler = createRetryProcessingHandler({
      queue,
      status,
      objects: objectRepoOf(status),
      now: () => new Date('2026-05-14T05:00:00.000Z'),
    });
    const res = await handler({ operation: 'retry', objectId: o.id }, makeUserCtx());
    expect(res.requeuedJobs).toHaveLength(2);
    for (const j of res.requeuedJobs) {
      expect(j.status).toBe('queued');
      expect(j.errorCode).toBeNull();
      expect(j.attempts).toBe(0);
    }
    expect(res.object.status).toBe('processing');
    expect(status.objects.get(o.id)?.status).toBe('processing');
  });

  test('only re-touches failed jobs (queued/running/succeeded untouched)', async () => {
    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    const o = seedObject({ id: validId, status: 'failed' });
    status.seed(o);
    queue.bindObjectToWorkspace(o.id, o.workspaceId);
    queue.seed({ id: 'jq', objectId: o.id, jobType: 'a', status: 'queued' });
    queue.seed({ id: 'jr', objectId: o.id, jobType: 'b', status: 'running' });
    queue.seed({ id: 'js', objectId: o.id, jobType: 'c', status: 'succeeded' });
    queue.seed({
      id: 'jf',
      objectId: o.id,
      jobType: 'd',
      status: 'failed',
      required: true,
      errorCode: 'X',
    });
    const handler = createRetryProcessingHandler({
      queue,
      status,
      objects: objectRepoOf(status),
    });
    const res = await handler({ operation: 'retry', objectId: o.id }, makeUserCtx());
    expect(res.requeuedJobs).toHaveLength(1);
    expect(res.requeuedJobs[0]?.id).toBe('jf');
    // Others untouched
    expect(queue.getRow('jq')?.status).toBe('queued');
    expect(queue.getRow('jr')?.status).toBe('running');
    expect(queue.getRow('js')?.status).toBe('succeeded');
  });

  test('works for api_key actor (no userId required)', async () => {
    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    const o = seedObject({ id: validId, status: 'failed' });
    status.seed(o);
    queue.bindObjectToWorkspace(o.id, o.workspaceId);
    queue.seed({
      id: 'j-1',
      objectId: o.id,
      jobType: 'scan_validation',
      required: true,
      status: 'failed',
    });
    const handler = createRetryProcessingHandler({
      queue,
      status,
      objects: objectRepoOf(status),
    });
    const res = await handler({ operation: 'retry', objectId: o.id }, makeApiKeyCtx());
    expect(res.requeuedJobs).toHaveLength(1);
  });

  test('returns the response without leaking provider config / credentials', async () => {
    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    const o: StorageObjectRecord = seedObject({
      id: validId,
      status: 'failed',
      // Hostile field that wouldn't actually exist on the type but mimics
      // an upstream row leak. We don't actually inject — the type forbids
      // it — but we DO assert the response shape allowlist.
    });
    status.seed(o);
    queue.bindObjectToWorkspace(o.id, o.workspaceId);
    queue.seed({
      id: 'j-1',
      objectId: o.id,
      jobType: 'scan_validation',
      required: true,
      status: 'failed',
    });
    const handler = createRetryProcessingHandler({
      queue,
      status,
      objects: objectRepoOf(status),
    });
    const res = await handler({ operation: 'retry', objectId: o.id }, makeUserCtx());
    const serialised = JSON.stringify(res);
    for (const banned of [
      'providerObjectKey',
      'provider_object_key',
      'providerId',
      'provider_kind',
      'endpoint',
      'region',
      'bucket',
      'credential_ref',
      'credentialRef',
      'accessKeyId',
      'secretAccessKey',
    ]) {
      expect(serialised).not.toContain(banned);
    }
  });
});

describe('createRetryProcessingHandler — validation + denials', () => {
  test('rejects malformed payload', async () => {
    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    const handler = createRetryProcessingHandler({
      queue,
      status,
      objects: objectRepoOf(status),
    });
    await expect(handler({ operation: 'retry' }, makeUserCtx())).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      handler({ operation: 'retry', objectId: 'not-uuid' }, makeUserCtx()),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      handler({ operation: 'retry', objectId: validId, extra: 1 }, makeUserCtx()),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('unknown object id -> "Object not found" envelope', async () => {
    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    const handler = createRetryProcessingHandler({
      queue,
      status,
      objects: objectRepoOf(status),
    });
    await expect(handler({ operation: 'retry', objectId: validId }, makeUserCtx())).rejects.toThrow(
      'Object not found',
    );
  });

  test('cross-workspace probe -> same "Object not found" envelope', async () => {
    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    const otherWorkspace = '00000000-0000-4000-8000-000000000099';
    const o = seedObject({ id: validId, workspaceId: otherWorkspace, status: 'failed' });
    status.seed(o);
    const handler = createRetryProcessingHandler({
      queue,
      status,
      objects: objectRepoOf(status),
    });
    await expect(
      handler(
        { operation: 'retry', objectId: validId },
        makeUserCtx({ workspaceId: TEST_WORKSPACE_ID }),
      ),
    ).rejects.toThrow('Object not found');
  });

  test('soft-deleted object -> "Object not found" envelope (no enumeration)', async () => {
    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    const o = seedObject({ id: validId, status: 'deleted' });
    status.seed(o);
    const handler = createRetryProcessingHandler({
      queue,
      status,
      objects: objectRepoOf(status),
    });
    await expect(handler({ operation: 'retry', objectId: validId }, makeUserCtx())).rejects.toThrow(
      'Object not found',
    );
  });

  test('object with no failed jobs is a successful no-op (requeuedJobs=[])', async () => {
    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    const o = seedObject({ id: validId, status: 'ready' });
    status.seed(o);
    queue.bindObjectToWorkspace(o.id, o.workspaceId);
    queue.seed({ id: 'js', objectId: o.id, jobType: 'a', status: 'succeeded', required: true });
    const handler = createRetryProcessingHandler({
      queue,
      status,
      objects: objectRepoOf(status),
    });
    const res = await handler({ operation: 'retry', objectId: o.id }, makeUserCtx());
    expect(res.requeuedJobs).toEqual([]);
    // Aggregate stays ready
    expect(res.object.status).toBe('ready');
  });

  test('default now() is used when not supplied', async () => {
    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    const o = seedObject({ id: validId, status: 'failed' });
    status.seed(o);
    queue.bindObjectToWorkspace(o.id, o.workspaceId);
    queue.seed({
      id: 'jf',
      objectId: o.id,
      jobType: 'scan_validation',
      required: true,
      status: 'failed',
    });
    const handler = createRetryProcessingHandler({
      queue,
      status,
      objects: objectRepoOf(status),
    });
    const res = await handler({ operation: 'retry', objectId: o.id }, makeUserCtx());
    expect(res.requeuedJobs).toHaveLength(1);
  });
});
