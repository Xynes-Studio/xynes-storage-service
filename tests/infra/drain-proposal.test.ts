/** Private proposed regression coverage; no provider, DB, child process or signal. */
import { beforeEach, afterEach, test, expect } from 'bun:test';
import { ProcessingWorker } from '../../src/actions/handlers/processing/worker';
import { AbandonedUploadCleanup } from '../../src/infra/cleanup/abandoned-uploads';
import { buildComposition } from '../../src/composition';
import { __resetRegistry } from '../../src/actions/registry';
import type { StorageDbClient } from '../../src/infra/db/client';
import type { UploadSessionRecord } from '../../src/actions/handlers/uploads/types';
import {
  FakeProcessingQueue,
  FakeObjectStatus,
  makeFindObject,
  seedObject,
} from '../actions/handlers/processing/_fakes';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
async function checkpoint() {
  await Promise.resolve();
  await Promise.resolve();
}
// The old API's stop-only behavior supplies the RED baseline. GREEN requires the
// new explicit drain method, while stop remains backwards compatible.
function beginDrain(target: { stop(): void; drain?: () => Promise<void> }) {
  return Promise.resolve(target.drain ? target.drain() : target.stop());
}
function workerFixture() {
  const queue = new FakeProcessingQueue();
  const status = new FakeObjectStatus();
  const object = seedObject({ status: 'processing' });
  status.seed(object);
  queue.bindObjectToWorkspace(object.id, object.workspaceId);
  queue.seed({
    id: 'long-scan',
    objectId: object.id,
    jobType: 'scan_validation',
    required: true,
    status: 'queued',
  });
  const entered = deferred();
  const released = deferred();
  const succeeded = deferred();
  const mark = queue.markSucceeded.bind(queue);
  queue.markSucceeded = async (input) => {
    const row = await mark(input);
    succeeded.resolve();
    return row;
  };
  const worker = new ProcessingWorker({
    queue,
    status,
    findObject: makeFindObject(status),
    runners: {
      scan_validation: async () => {
        entered.resolve();
        await released.promise;
        return {};
      },
    },
  });
  return { worker, queue, status, object, entered, released, succeeded };
}
function cleanupFixture() {
  const entered = deferred();
  const released = deferred();
  const completed = deferred();
  let marked = false;
  const session = {
    id: 'session',
    workspaceId: 'workspace',
    objectId: 'object',
    uploadMethod: 'single',
    status: 'pending',
  } as UploadSessionRecord;
  const cleanup = new AbandonedUploadCleanup({
    sessions: {
      listExpiredPending: async () => [session],
      markExpiredIfPending: async () => {
        entered.resolve();
        await released.promise;
        marked = true;
        completed.resolve();
        return session;
      },
    },
    objects: { findByIdForWorkspace: async () => null },
    providers: { resolveDefaultForWorkspace: async () => null },
  });
  return { cleanup, entered, released, completed, marked: () => marked };
}
beforeEach(__resetRegistry);
afterEach(__resetRegistry);

test('worker drain stays pending until the admitted polling pass commits', async () => {
  const f = workerFixture();
  f.worker.start(60_000);
  await f.entered.promise;
  let settled = false;
  const draining = beginDrain(f.worker).finally(() => {
    settled = true;
  });
  try {
    await checkpoint();
    expect(settled).toBe(false);
    expect(f.queue.getRow('long-scan')?.status).toBe('running');
    f.released.resolve();
    await draining;
    expect(f.queue.getRow('long-scan')?.status).toBe('succeeded');
    expect(f.status.objects.get(f.object.id)?.status).toBe('ready');
  } finally {
    f.released.resolve();
    await f.succeeded.promise;
    await draining;
    f.worker.stop();
  }
}, 1000);

test('worker drain also waits for direct runOnce work', async () => {
  const f = workerFixture();
  const pass = f.worker.runOnce();
  await f.entered.promise;
  let settled = false;
  const draining = beginDrain(f.worker).finally(() => {
    settled = true;
  });
  try {
    await checkpoint();
    expect(settled).toBe(false);
    f.released.resolve();
    await draining;
    expect((await pass).succeeded).toBe(1);
  } finally {
    f.released.resolve();
    await pass;
    await draining;
  }
}, 1000);

test('concurrent worker drain calls wait for the same work without duplicate execution', async () => {
  const f = workerFixture();
  f.worker.start(60_000);
  await f.entered.promise;
  let settled = 0;
  const draining = [beginDrain(f.worker), beginDrain(f.worker)].map((p) =>
    p.finally(() => {
      settled++;
    }),
  );
  try {
    await checkpoint();
    expect(settled).toBe(0);
    f.released.resolve();
    await Promise.all(draining);
    expect(f.queue.markSucceededCount).toBe(1);
  } finally {
    f.released.resolve();
    await f.succeeded.promise;
    await Promise.all(draining);
    f.worker.stop();
  }
}, 1000);

test('failed worker pass is awaited and reported to a drain caller', async () => {
  const entered = deferred();
  const released = deferred();
  const failure = new Error('fixture pass failed');
  const f = workerFixture();
  f.queue.claimNextQueuedJob = async () => {
    entered.resolve();
    await released.promise;
    throw failure;
  };
  const pass = f.worker.runOnce();
  const passResult = pass.catch((error) => error);
  await entered.promise;
  let settled = false;
  const draining = beginDrain(f.worker)
    .then(
      () => null,
      (error) => error,
    )
    .finally(() => {
      settled = true;
    });
  try {
    await checkpoint();
    expect(settled).toBe(false);
    released.resolve();
    expect(await draining).toBe(failure);
    expect(await passResult).toBe(failure);
  } finally {
    released.resolve();
    await passResult;
    await draining;
  }
}, 1000);

test('cleanup drain waits for its admitted metadata mutation', async () => {
  const f = cleanupFixture();
  f.cleanup.start(1);
  await f.entered.promise;
  let settled = false;
  const draining = beginDrain(f.cleanup).finally(() => {
    settled = true;
  });
  try {
    await checkpoint();
    expect(settled).toBe(false);
    expect(f.marked()).toBe(false);
    f.released.resolve();
    await draining;
    expect(f.marked()).toBe(true);
  } finally {
    f.released.resolve();
    await f.completed.promise;
    await draining;
    f.cleanup.stop();
  }
}, 1000);

test('cleanup concurrent zero-work call cannot replace the pass being drained', async () => {
  const f = cleanupFixture();
  const pass = f.cleanup.runOnce();
  await f.entered.promise;
  expect(await f.cleanup.runOnce()).toEqual({ scanned: 0, expired: 0, deferred: 0, raced: 0 });
  let settled = false;
  const draining = beginDrain(f.cleanup).finally(() => {
    settled = true;
  });
  try {
    await checkpoint();
    expect(settled).toBe(false);
    f.released.resolve();
    await draining;
    expect((await pass).expired).toBe(1);
  } finally {
    f.released.resolve();
    await pass;
    await draining;
    f.cleanup.stop();
  }
}, 1000);

test('idle drains resolve and legacy stop remains synchronous', async () => {
  const f = workerFixture();
  expect(f.worker.stop()).toBeUndefined();
  expect(await beginDrain(f.worker)).toBeUndefined();
  const c = cleanupFixture();
  expect(c.cleanup.stop()).toBeUndefined();
  expect(await beginDrain(c.cleanup)).toBeUndefined();
});

function compositionFixture() {
  let closed = 0;
  const db: StorageDbClient = {
    db: {} as never,
    client: {} as never,
    close: async () => {
      closed++;
    },
  };
  const composition = buildComposition({
    env: { NODE_ENV: 'test', STORAGE_PROCESSOR_MODE: 'stub', DATABASE_URL: 'fixture' },
    createDb: () => db,
  });
  const calls: string[] = [];
  const workerPass = deferred();
  const cleanupPass = deferred();
  // These existing object ports isolate composition ordering, while earlier
  // tests prove actual worker/cleanup drain behavior.
  Object.assign(composition.worker, {
    drain: () => {
      calls.push('worker');
      return workerPass.promise;
    },
  });
  Object.assign(composition.cleanup, {
    drain: () => {
      calls.push('cleanup');
      return cleanupPass.promise;
    },
  });
  return { composition, calls, workerPass, cleanupPass, closed: () => closed };
}

test('composition waits for both drains before closing its owned DB', async () => {
  const f = compositionFixture();
  const stopping = f.composition.shutdown();
  try {
    await checkpoint();
    expect(f.calls).toEqual(['worker', 'cleanup']);
    expect(f.closed()).toBe(0);
    f.workerPass.resolve();
    await checkpoint();
    expect(f.closed()).toBe(0);
    f.cleanupPass.resolve();
    await stopping;
    expect(f.closed()).toBe(1);
  } finally {
    f.workerPass.resolve();
    f.cleanupPass.resolve();
    await stopping;
  }
}, 1000);

test('one failed drain cannot close the DB while the other pass is active', async () => {
  const f = compositionFixture();
  const failure = new Error('fixture worker failed');
  let settled = false;
  const stopping = f.composition
    .shutdown()
    .then(
      () => null,
      (error) => error,
    )
    .finally(() => {
      settled = true;
    });
  try {
    f.workerPass.reject(failure);
    // Original source ignores this fake API, so consume rejection separately.
    void f.workerPass.promise.catch(() => {});
    await checkpoint();
    expect(f.closed()).toBe(0);
    expect(settled).toBe(false);
    f.cleanupPass.resolve();
    expect(await stopping).toBe(failure);
    expect(f.closed()).toBe(1);
  } finally {
    f.cleanupPass.resolve();
    await stopping;
  }
}, 1000);

test('terminal restart diagnostic does not reclaim an ownerless seeded running row', async () => {
  const f = workerFixture();
  // No old worker starts or admits work. Only persisted terminal-failure shape
  // remains. This diagnostic intentionally preserves current fail-closed policy.
  const stranded = await f.queue.claimNextQueuedJob({ now: new Date() });
  expect(stranded?.id).toBe('long-scan');
  const result = await f.worker.runOnce();
  expect(result.attempted).toBe(0);
  expect(f.queue.getRow('long-scan')?.status).toBe('running');
});
