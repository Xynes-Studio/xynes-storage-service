/**
 * STORAGE-7 — dispatcher tests.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import {
  STORAGE_PROCESS_RETRY_ACTION_KEY,
  buildProcessingActionHandler,
  registerProcessingActionHandlers,
} from '../../../../src/actions/handlers/processing';
import { ValidationError } from '../../../../src/actions/errors';
import { __resetRegistry, getHandler } from '../../../../src/actions/registry';
import { FakeObjectStatus, FakeProcessingQueue, makeUserCtx, resetIds, seedObject } from './_fakes';

function objectsOf(status: FakeObjectStatus) {
  return {
    findByIdForWorkspace: async (input: { objectId: string; workspaceId: string }) => {
      const o = status.objects.get(input.objectId);
      if (!o || o.workspaceId !== input.workspaceId) return null;
      return o;
    },
  };
}

beforeEach(() => {
  resetIds();
  __resetRegistry();
});

describe('processing action dispatcher', () => {
  test('action key constant matches the gateway route seed', () => {
    expect(STORAGE_PROCESS_RETRY_ACTION_KEY).toBe('platform.storage.objects.process.retry');
  });

  test('missing operation -> ValidationError', async () => {
    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    const handler = buildProcessingActionHandler({
      queue,
      status,
      objects: objectsOf(status),
    });
    await expect(handler({}, makeUserCtx())).rejects.toBeInstanceOf(ValidationError);
  });

  test('null payload -> ValidationError', async () => {
    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    const handler = buildProcessingActionHandler({
      queue,
      status,
      objects: objectsOf(status),
    });
    await expect(handler(null as unknown, makeUserCtx())).rejects.toBeInstanceOf(ValidationError);
  });

  test('non-object payload -> ValidationError', async () => {
    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    const handler = buildProcessingActionHandler({
      queue,
      status,
      objects: objectsOf(status),
    });
    await expect(handler('string-payload' as unknown, makeUserCtx())).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  test('unknown operation -> ValidationError', async () => {
    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    const handler = buildProcessingActionHandler({
      queue,
      status,
      objects: objectsOf(status),
    });
    await expect(handler({ operation: 'cancel' }, makeUserCtx())).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  test('retry operation reaches the retry handler', async () => {
    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    const o = seedObject({ status: 'failed' });
    status.seed(o);
    queue.bindObjectToWorkspace(o.id, o.workspaceId);
    queue.seed({
      id: 'jf',
      objectId: o.id,
      jobType: 'scan_validation',
      required: true,
      status: 'failed',
    });
    const handler = buildProcessingActionHandler({
      queue,
      status,
      objects: objectsOf(status),
    });
    const res = (await handler({ operation: 'retry', objectId: o.id }, makeUserCtx())) as {
      requeuedJobs: unknown[];
    };
    expect(res.requeuedJobs).toHaveLength(1);
  });

  test('registerProcessingActionHandlers wires the action key into the global registry', () => {
    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    registerProcessingActionHandlers({
      queue,
      status,
      objects: objectsOf(status),
    });
    expect(getHandler(STORAGE_PROCESS_RETRY_ACTION_KEY)).toBeDefined();
  });
});
