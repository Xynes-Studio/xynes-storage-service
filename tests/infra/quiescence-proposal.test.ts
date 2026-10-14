/** Review-only local HTTP/Unix fixtures: no provider, DB, Docker or real signal. */
import { expect, test, spyOn } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  chmodSync,
  rmSync,
  statSync,
  realpathSync,
  writeFileSync,
  linkSync,
  symlinkSync,
  renameSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { Hono } from 'hono';
import { startLifecycle } from '../../src/infra/lifecycle';
import type { CompositionRoot } from '../../src/composition';
import { ProcessingWorker } from '../../src/actions/handlers/processing/worker';
import type { JobRunnerContext } from '../../src/actions/handlers/processing/types';
import {
  FakeProcessingQueue,
  FakeObjectStatus,
  makeFindObject,
  seedObject,
} from '../actions/handlers/processing/_fakes';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function module() {
  expect(existsSync(join(import.meta.dir, '../../src/infra/quiescence.ts'))).toBe(true);
  return import('../../src/infra/quiescence');
}
const owner = 'a'.repeat(32);
const other = 'b'.repeat(32);
function poller(pass: Promise<void> = Promise.resolve()) {
  return {
    starts: 0,
    stops: 0,
    start() {
      this.starts++;
    },
    stop() {
      this.stops++;
    },
    drain: () => pass,
  };
}
async function fixture(workerPass?: Promise<void>, cleanupPass?: Promise<void>) {
  const { Quiescence } = await module();
  const worker = poller(workerPass);
  const cleanup = poller(cleanupPass);
  const gate = new Quiescence({
    worker,
    cleanup,
    workerIntervalMs: 5000,
    cleanupIntervalMs: 60000,
  });
  return { gate, worker, cleanup };
}
async function checkpoint() {
  await Promise.resolve();
  await Promise.resolve();
}

test('whole admitted HTTP promise drains even after request cancellation', async () => {
  const f = await fixture();
  const entered = deferred();
  const released = deferred();
  const app = new Hono();
  app.get('/work', async () => {
    entered.resolve();
    await released.promise;
    return new Response('finished');
  });
  const controller = new AbortController();
  const response = f.gate.wrap((req) => app.fetch(req))(
    new Request('http://local/work', { signal: controller.signal }),
  );
  await entered.promise;
  controller.abort();
  let settled = false;
  const drain = f.gate.quiesce(owner, 500, 2000).then((result) => {
    settled = true;
    return result;
  });
  try {
    await checkpoint();
    expect(settled).toBe(false);
    expect(
      (await f.gate.wrap((req) => app.fetch(req))(new Request('http://local/work'))).status,
    ).toBe(503);
    expect(f.gate.status(owner).active_http).toBe(1);
    released.resolve();
    await response;
    expect((await drain).state).toBe('quiesced');
  } finally {
    released.resolve();
    f.gate.resume(owner);
  }
});
test('long worker and cleanup must both finish before proof', async () => {
  const worker = deferred();
  const cleanup = deferred();
  const f = await fixture(worker.promise, cleanup.promise);
  let settled = false;
  const drain = f.gate.quiesce(owner, 500, 2000).then((value) => {
    settled = true;
    return value;
  });
  try {
    worker.resolve();
    await checkpoint();
    expect(settled).toBe(false);
    expect(f.gate.consumeProof()).toBe(false);
    cleanup.resolve();
    expect((await drain).state).toBe('quiesced');
  } finally {
    worker.resolve();
    cleanup.resolve();
    f.gate.resume(owner);
  }
});
test('timeout keeps process DB and admission fence alive until explicit resume', async () => {
  const pass = deferred();
  const f = await fixture(pass.promise);
  try {
    expect((await f.gate.quiesce(owner, 10, 2000)).state).toBe('timeout');
    expect(f.gate.consumeProof()).toBe(false);
    expect(f.gate.status(owner).admission_open).toBe(false);
    expect(f.worker.starts).toBe(0);
    expect(f.gate.resume(other)).toBe(false);
    expect(f.gate.resume(owner)).toBe(true);
    expect(f.worker.starts).toBe(1);
    expect(f.cleanup.starts).toBe(1);
    expect(f.gate.status(owner).admission_open).toBe(true);
  } finally {
    pass.resolve();
    f.gate.resume(owner);
  }
});
test('cancelled caller gets no proof and retains the fence', async () => {
  const pass = deferred();
  const f = await fixture(pass.promise);
  const controller = new AbortController();
  const drain = f.gate.quiesce(owner, 500, 2000, controller.signal);
  controller.abort();
  try {
    expect((await drain).state).toBe('cancelled');
    expect(f.gate.consumeProof()).toBe(false);
    expect(f.gate.status(owner).admission_open).toBe(false);
  } finally {
    pass.resolve();
    f.gate.resume(owner);
  }
});
test('lease expiry safely resumes polling and invalidates pending proof', async () => {
  const pass = deferred();
  const f = await fixture(pass.promise);
  try {
    expect((await f.gate.quiesce(owner, 5, 1000)).state).toBe('timeout');
    await Bun.sleep(1050);
    expect(f.gate.status(owner).admission_open).toBe(true);
    expect(f.worker.starts).toBe(1);
    expect(f.gate.consumeProof()).toBe(false);
    pass.resolve();
    await checkpoint();
    expect(f.gate.consumeProof()).toBe(false);
  } finally {
    pass.resolve();
    f.gate.resume(owner);
  }
}, 2000);
test('proof consumption atomically disables resume and lease reopening', async () => {
  const f = await fixture();
  expect((await f.gate.quiesce(owner, 100, 1000)).state).toBe('quiesced');
  expect(f.gate.consumeProof()).toBe(true);
  expect(f.gate.consumeProof()).toBe(false);
  expect(f.gate.resume(owner)).toBe(false);
  await Bun.sleep(1050);
  expect(f.gate.status(owner).admission_open).toBe(false);
  expect(f.worker.starts).toBe(0);
}, 2000);
test('different owner cannot steal quiescence and rejection never becomes proof', async () => {
  const pass = deferred();
  const f = await fixture(pass.promise);
  const draining = f.gate.quiesce(owner, 100, 2000);
  try {
    expect((await f.gate.quiesce(other, 10, 2000)).state).toBe('busy');
  } finally {
    pass.resolve();
    await draining;
    f.gate.resume(owner);
  }
  const failed = await fixture(Promise.reject(new Error('PRIVATE_PROVIDER_DETAIL')));
  try {
    expect((await failed.gate.quiesce(owner, 100, 2000)).state).toBe('failed');
    expect(failed.gate.consumeProof()).toBe(false);
  } finally {
    failed.gate.resume(owner);
  }
});
test('hosted lifecycle refuses SIGTERM without consuming valid proof', async () => {
  const f = await fixture();
  let closes = 0;
  let exits = 0;
  const signals = new Map<string, () => void>();
  const composition = {
    worker: f.worker,
    cleanup: f.cleanup,
    shutdown: async () => {
      closes++;
    },
  } as unknown as CompositionRoot;
  const lifecycle = startLifecycle(composition, {
    env: {},
    quiescence: f.gate,
    registerSignalHandler: (signal, callback) => {
      signals.set(signal, callback);
    },
    removeSignalHandler: () => {},
    onShutdownComplete: () => {
      exits++;
    },
  });
  signals.get('SIGTERM')!();
  await checkpoint();
  expect(closes).toBe(0);
  expect(exits).toBe(0);
  expect((await f.gate.quiesce(owner, 100, 2000)).state).toBe('quiesced');
  signals.get('SIGTERM')!();
  await Bun.sleep(5);
  expect(closes).toBe(1);
  expect(exits).toBe(1);
  expect(f.gate.resume(owner)).toBe(false);
  await lifecycle.stop();
});
function unixCall(socketPath: string, token: string, path: string, body: Record<string, unknown>) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const raw = JSON.stringify(body);
    const req = request(
      {
        socketPath,
        method: 'POST',
        path,
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(raw),
        },
      },
      (res) => {
        let value = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          value += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode!, body: value }));
      },
    );
    req.on('error', reject);
    req.end(raw);
  });
}
test('private Unix channel requires token, exact owner and fixed control schema', async () => {
  const { startPrivateControl } = await module();
  const f = await fixture();
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'apex-control-fixture-')));
  chmodSync(directory, 0o700);
  const unix = join(directory, 'control.sock');
  const token = 'c'.repeat(64);
  const control = await startPrivateControl(f.gate, { unix, token });
  try {
    expect(statSync(unix).mode & 0o777).toBe(0o600);
    expect(
      (await unixCall(unix, 'd'.repeat(64), '/quiesce', { owner, timeout_ms: 100, lease_ms: 2000 }))
        .status,
    ).toBe(403);
    expect(f.gate.status(owner).admission_open).toBe(true);
    expect(
      (
        await unixCall(unix, token, '/quiesce', {
          owner,
          timeout_ms: 100,
          lease_ms: 2000,
          command: 'delete',
        })
      ).status,
    ).toBe(400);
    const quiet = await unixCall(unix, token, '/quiesce', {
      owner,
      timeout_ms: 100,
      lease_ms: 2000,
    });
    expect(quiet.status).toBe(200);
    expect(JSON.parse(quiet.body).state).toBe('quiesced');
    expect((await unixCall(unix, token, '/resume', { owner: other })).status).toBe(409);
    expect((await unixCall(unix, token, '/resume', { owner })).status).toBe(200);
  } finally {
    f.gate.resume(owner);
    await control.close();
    rmSync(directory, { recursive: true });
  }
});

test('resume does not restart an old worker polling generation', async () => {
  const queue = new FakeProcessingQueue();
  const status = new FakeObjectStatus();
  const entered = deferred();
  const released = deferred();
  queue.claimNextQueuedJob = async () => {
    entered.resolve();
    await released.promise;
    return null;
  };
  const worker = new ProcessingWorker({
    queue,
    status,
    findObject: makeFindObject(status),
    runners: {},
  });
  const timers = spyOn(globalThis, 'setTimeout');
  try {
    worker.start(60000);
    await entered.promise;
    worker.stop();
    worker.start(60000);
    released.resolve();
    await worker.runOnce();
    await checkpoint();
    expect(timers.mock.calls.filter((call) => call[1] === 60000)).toHaveLength(1);
  } finally {
    released.resolve();
    worker.stop();
    for (const result of timers.mock.results)
      if (result.type === 'return') clearTimeout(result.value);
    timers.mockRestore();
  }
});

test('control credential file refuses links permissions and invalid secrets', async () => {
  const { readControlToken } = await module();
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'apex-token-fixture-')));
  chmodSync(directory, 0o700);
  const path = join(directory, 'token');
  try {
    writeFileSync(path, 'c'.repeat(64), { mode: 0o600 });
    expect(readControlToken(path)).toBe('c'.repeat(64));
    chmodSync(path, 0o644);
    expect(() => readControlToken(path)).toThrow('Storage control refused');
    chmodSync(path, 0o600);
    linkSync(path, join(directory, 'hardlink'));
    expect(() => readControlToken(path)).toThrow('Storage control refused');
    rmSync(join(directory, 'hardlink'));
    symlinkSync(path, join(directory, 'symlink'));
    expect(() => readControlToken(join(directory, 'symlink'))).toThrow('Storage control refused');
    writeFileSync(path, 'PRIVATE_BAD_SECRET');
    expect(() => readControlToken(path)).toThrow('Storage control refused');
  } finally {
    rmSync(directory, { recursive: true });
  }
});
test('unknown preexisting Unix socket path is never adopted or removed', async () => {
  const { startPrivateControl } = await module();
  const f = await fixture();
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'apex-control-owner-')));
  chmodSync(directory, 0o700);
  const unix = join(directory, 'control.sock');
  writeFileSync(unix, 'UNKNOWN_RESOURCE', { mode: 0o600 });
  try {
    await expect(startPrivateControl(f.gate, { unix, token: 'c'.repeat(64) })).rejects.toThrow(
      'Storage control refused',
    );
    expect(statSync(unix).isFile()).toBe(true);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('hosted SIGTERM retains permanent fence while database teardown is pending', async () => {
  const f = await fixture();
  const closing = deferred();
  let closes = 0;
  let exits = 0;
  const signals = new Map<string, () => void>();
  const composition = {
    worker: f.worker,
    cleanup: f.cleanup,
    shutdown: async () => {
      closes++;
      await closing.promise;
    },
  } as unknown as CompositionRoot;
  const lifecycle = startLifecycle(composition, {
    env: {},
    quiescence: f.gate,
    registerSignalHandler: (signal, callback) => {
      signals.set(signal, callback);
    },
    removeSignalHandler: () => {},
    onShutdownComplete: () => {
      exits++;
    },
  });
  try {
    expect((await f.gate.quiesce(owner, 100, 1000)).state).toBe('quiesced');
    signals.get('SIGTERM')!();
    await checkpoint();
    expect(closes).toBe(1);
    const starts = f.worker.starts;
    await Bun.sleep(1050);
    expect(f.gate.resume(owner)).toBe(false);
    expect(f.gate.status(owner).admission_open).toBe(false);
    expect(f.worker.starts).toBe(starts);
    expect(exits).toBe(0);
    closing.resolve();
    await lifecycle.stop();
    await checkpoint();
    expect(exits).toBe(1);
  } finally {
    closing.resolve();
    await lifecycle.stop();
  }
}, 2000);

test('disconnected Unix caller cannot turn pending work into a stop proof', async () => {
  const { startPrivateControl } = await module();
  const blocked = deferred();
  const f = await fixture(blocked.promise);
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'apex-control-disconnect-')));
  chmodSync(directory, 0o700);
  const unix = join(directory, 'control.sock');
  const token = 'c'.repeat(64);
  const control = await startPrivateControl(f.gate, { unix, token });
  const raw = JSON.stringify({ owner, timeout_ms: 500, lease_ms: 2000 });
  const req = request({
    socketPath: unix,
    method: 'POST',
    path: '/quiesce',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(raw),
    },
  });
  req.on('error', () => {});
  req.end(raw);
  try {
    for (let attempt = 0; attempt < 100 && f.gate.status(owner).admission_open; attempt++)
      await Bun.sleep(1);
    expect(f.gate.status(owner).admission_open).toBe(false);
    req.destroy();
    for (let attempt = 0; attempt < 100 && f.gate.status(owner).state !== 'cancelled'; attempt++)
      await Bun.sleep(1);
    expect(f.gate.status(owner).state).toBe('cancelled');
    expect(f.gate.consumeProof()).toBe(false);
    expect(f.gate.status(owner).admission_open).toBe(false);
  } finally {
    req.destroy();
    blocked.resolve();
    f.gate.resume(owner);
    await control.close();
    rmSync(directory, { recursive: true });
  }
});

test('qualified lifecycle closes its owned Unix control listener; refused stop preserves it', async () => {
  const { startPrivateControl } = await module();
  const f = await fixture();
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'apex-control-shutdown-')));
  chmodSync(directory, 0o700);
  const unix = join(directory, 'control.sock');
  const token = 'c'.repeat(64);
  const control = await startPrivateControl(f.gate, { unix, token });
  let closes = 0;
  let exits = 0;
  const signals = new Map<string, () => void>();
  const composition = {
    worker: f.worker,
    cleanup: f.cleanup,
    shutdown: async () => {
      closes++;
    },
  } as unknown as CompositionRoot;
  const lifecycle = startLifecycle(composition, {
    env: {},
    quiescence: f.gate,
    closeControl: control.close,
    registerSignalHandler: (signal, callback) => {
      signals.set(signal, callback);
    },
    removeSignalHandler: () => {},
    onShutdownComplete: () => {
      exits++;
    },
  });
  try {
    signals.get('SIGTERM')!();
    await checkpoint();
    expect(existsSync(unix)).toBe(true);
    expect(closes).toBe(0);
    expect((await f.gate.quiesce(owner, 100, 2000)).state).toBe('quiesced');
    signals.get('SIGTERM')!();
    await lifecycle.stop();
    await checkpoint();
    expect(exits).toBe(1);
    expect(closes).toBe(1);
    expect(existsSync(unix)).toBe(false);
    const replacement = await fixture();
    const next = await startPrivateControl(replacement.gate, { unix, token });
    await next.close();
  } finally {
    if (existsSync(unix)) await control.close();
    rmSync(directory, { recursive: true });
  }
});

test('control close refuses a replaced foreign path before native unlink', async () => {
  const { startPrivateControl } = await module();
  const f = await fixture();
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'apex-control-replaced-')));
  chmodSync(directory, 0o700);
  const unix = join(directory, 'control.sock');
  const moved = join(directory, 'owned.sock');
  const control = await startPrivateControl(f.gate, { unix, token: 'c'.repeat(64) });
  renameSync(unix, moved);
  writeFileSync(unix, 'FOREIGN_RESOURCE', { mode: 0o600 });
  try {
    await expect(control.close()).rejects.toThrow('Storage control refused');
    expect(existsSync(unix)).toBe(true);
    expect(readFileSync(unix, 'utf8')).toBe('FOREIGN_RESOURCE');
  } finally {
    if (existsSync(unix)) rmSync(unix);
    renameSync(moved, unix);
    try {
      await control.close();
    } catch {
      /* Failed baseline already closed its own listener. */
    }
    rmSync(directory, { recursive: true });
  }
});
test('failed qualified control teardown cannot close DB or claim process exit', async () => {
  const f = await fixture();
  let closes = 0;
  let exits = 0;
  const signals = new Map<string, () => void>();
  const composition = {
    worker: f.worker,
    cleanup: f.cleanup,
    shutdown: async () => {
      closes++;
    },
  } as unknown as CompositionRoot;
  const lifecycle = startLifecycle(composition, {
    env: {},
    quiescence: f.gate,
    closeControl: async () => {
      throw new Error('PRIVATE_CONTROL_DETAIL');
    },
    registerSignalHandler: (signal, callback) => {
      signals.set(signal, callback);
    },
    removeSignalHandler: () => {},
    onShutdownComplete: () => {
      exits++;
    },
  });
  expect((await f.gate.quiesce(owner, 100, 2000)).state).toBe('quiesced');
  signals.get('SIGTERM')!();
  await expect(lifecycle.stop()).rejects.toThrow('Storage shutdown refused');
  expect(closes).toBe(0);
  expect(exits).toBe(0);
  expect(f.gate.resume(owner)).toBe(false);
});

for (const jobType of ['scan_validation', 'video_probe'] as const) {
  test(`a ${jobType} rejection cannot release a pass while an admitted sibling is alive`, async () => {
    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    const object = seedObject({ status: 'processing' });
    const otherObject = seedObject({ status: 'processing' });
    for (const source of [object, otherObject]) {
      status.seed(source);
      queue.bindObjectToWorkspace(source.id, source.workspaceId);
      if (jobType !== 'scan_validation')
        queue.seed({
          id: 'prior-scan-' + source.id,
          objectId: source.id,
          jobType: 'scan_validation',
          required: true,
          status: 'succeeded',
        });
    }
    queue.seed({ id: 'rejecting', objectId: object.id, jobType, required: true, status: 'queued' });
    queue.seed({
      id: 'still-active',
      objectId: otherObject.id,
      jobType,
      required: true,
      status: 'queued',
    });
    const entered = deferred();
    const rejected = deferred();
    const released = deferred();
    let active = false;
    let settled = false;
    const error = new Error('inert database rejection');
    const mark = queue.markSucceeded.bind(queue);
    queue.markSucceeded = async (input) => {
      if (input.jobId === 'rejecting') {
        rejected.resolve();
        throw error;
      }
      return mark(input);
    };
    const worker = new ProcessingWorker({
      queue,
      status,
      findObject: makeFindObject(status),
      maxConcurrent: 2,
      maxConcurrentPerWorkspace: 2,
      runners: {
        [jobType]: async ({ job }: JobRunnerContext) => {
          if (job.id === 'still-active') {
            active = true;
            entered.resolve();
            await released.promise;
            active = false;
          }
          return {};
        },
      },
    });
    const cleanup = poller();
    const { Quiescence } = await module();
    const gate = new Quiescence({
      worker,
      cleanup,
      workerIntervalMs: 60000,
      cleanupIntervalMs: 60000,
    });
    const pass = worker.runOnce();
    const observed = pass.then(
      () => {
        settled = true;
        return null;
      },
      (failure: unknown) => {
        settled = true;
        return failure;
      },
    );
    try {
      await entered.promise;
      await rejected.promise;
      await Bun.sleep(1);
      expect(active).toBe(true);
      expect(settled).toBe(false);
      const proof = await gate.quiesce(owner, 5, 2000);
      expect(proof.state).toBe('timeout');
      expect(gate.consumeProof()).toBe(false);
      released.resolve();
      expect(await observed).toBe(error);
      expect(active).toBe(false);
      expect((await gate.quiesce(owner, 100, 2000)).state).toBe('failed');
      expect(gate.consumeProof()).toBe(false);
    } finally {
      released.resolve();
      await observed;
      worker.stop();
      gate.resume(owner);
      worker.stop();
    }
  });
}

test('immediate resume prevents stale drain callbacks from stopping new polling', async () => {
  const { Quiescence } = await module();
  const events: string[] = [];
  function sourceLikePoller(name: string) {
    return {
      running: true,
      start() {
        this.running = true;
        events.push(name + ':start');
      },
      stop() {
        this.running = false;
        events.push(name + ':stop');
      },
      async drain() {
        events.push(name + ':drain');
        this.stop();
      },
    };
  }
  const worker = sourceLikePoller('worker');
  const cleanup = sourceLikePoller('cleanup');
  const gate = new Quiescence({
    worker,
    cleanup,
    workerIntervalMs: 5000,
    cleanupIntervalMs: 60000,
  });
  const pending = gate.quiesce(owner, 100, 2000);
  expect(gate.resume(owner)).toBe(true);
  expect((await pending).state).toBe('cancelled');
  expect(gate.status(owner).admission_open).toBe(true);
  expect(worker.running).toBe(true);
  expect(cleanup.running).toBe(true);
  expect(events).toEqual(['worker:stop', 'cleanup:stop', 'worker:start', 'cleanup:start']);
});

test('batch reports the first chronological rejection after all admitted jobs settle', async () => {
  const queue = new FakeProcessingQueue();
  const status = new FakeObjectStatus();
  for (const id of ['slow-first', 'fast-second']) {
    const object = seedObject({ status: 'processing' });
    status.seed(object);
    queue.bindObjectToWorkspace(object.id, object.workspaceId);
    queue.seed({
      id,
      objectId: object.id,
      jobType: 'scan_validation',
      required: true,
      status: 'queued',
    });
  }
  const held = deferred();
  const entered = deferred();
  const firstRejected = deferred();
  const firstError = new Error('first chronological error');
  const laterError = new Error('later chronological error');
  queue.markSucceeded = async (input) => {
    if (input.jobId === 'fast-second') {
      firstRejected.resolve();
      throw firstError;
    }
    throw laterError;
  };
  const worker = new ProcessingWorker({
    queue,
    status,
    findObject: makeFindObject(status),
    maxConcurrent: 2,
    maxConcurrentPerWorkspace: 2,
    runners: {
      scan_validation: async ({ job }) => {
        if (job.id === 'slow-first') {
          entered.resolve();
          await held.promise;
        }
        return {};
      },
    },
  });
  const pass = worker.runOnce();
  const result = pass.then(
    () => null,
    (failure: unknown) => failure,
  );
  try {
    await entered.promise;
    await firstRejected.promise;
    held.resolve();
    expect(await result).toBe(firstError);
  } finally {
    held.resolve();
    await result;
    worker.stop();
  }
});
