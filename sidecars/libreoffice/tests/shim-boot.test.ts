/**
 * STORAGE-FU-5-FU-G — defaultFs + boot() tests.
 *
 * Exercises the production-wired adapters that the unit shim tests
 * skip (they inject in-memory fakes). Touches `os.tmpdir()` via
 * node:fs/promises and a fake `serve` function.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as nodeFs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { boot, defaultFs, type ServeFn, type ServerHandle } from '../src/shim';

// ── defaultFs adapter ───────────────────────────────────────────────────

describe('defaultFs', () => {
  const created: string[] = [];

  afterEach(async () => {
    while (created.length > 0) {
      const p = created.pop()!;
      try {
        await nodeFs.rm(p, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  test('mkdtemp creates a real directory + readdir lists empty', async () => {
    const prefix = path.join(os.tmpdir(), 'fu-g-test-');
    const dir = await defaultFs.mkdtemp(prefix);
    created.push(dir);
    expect(dir.startsWith(prefix)).toBe(true);
    const entries = await defaultFs.readdir(dir);
    expect(entries).toEqual([]);
  });

  test('writeFile + readFile round-trip bytes', async () => {
    const dir = await defaultFs.mkdtemp(path.join(os.tmpdir(), 'fu-g-test-'));
    created.push(dir);
    const sample = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const filePath = path.join(dir, 'sample.bin');
    await defaultFs.writeFile(filePath, sample);
    const readBack = await defaultFs.readFile(filePath);
    expect(readBack).toEqual(sample);
  });

  test('rm with recursive+force removes a populated dir', async () => {
    const dir = await defaultFs.mkdtemp(path.join(os.tmpdir(), 'fu-g-test-'));
    await defaultFs.writeFile(path.join(dir, 'a.txt'), new Uint8Array([0x41]));
    await defaultFs.rm(dir, { recursive: true, force: true });
    let exists = true;
    try {
      await nodeFs.access(dir);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });
});

// ── boot() — injected serve ─────────────────────────────────────────────

interface FakeServerCapture {
  port: number;
  hostname: string;
  fetch: (req: Request) => Promise<Response> | Response;
  error: (err: Error) => Response;
}

function makeFakeServe(): { serve: ServeFn; capture: FakeServerCapture[]; stopCalls: number[] } {
  const capture: FakeServerCapture[] = [];
  const stopCalls: number[] = [];
  const serve: ServeFn = (options) => {
    const idx = capture.length;
    capture.push({
      port: options.port,
      hostname: options.hostname,
      fetch: options.fetch,
      error: options.error,
    });
    const handle: ServerHandle = {
      stop: () => {
        stopCalls.push(idx);
      },
    };
    return handle;
  };
  return { serve, capture, stopCalls };
}

describe('boot()', () => {
  test('uses resolved config + emits shim.boot log line', () => {
    const { serve, capture } = makeFakeServe();
    const logs: string[] = [];
    boot({
      env: {
        STORAGE_SIDECAR_PORT: '9876',
        STORAGE_SIDECAR_HOSTNAME: '127.0.0.1',
      },
      serve,
      soffice: {
        async run() {
          return { exitCode: 1, timedOut: false };
        },
      },
      log: (line) => logs.push(line),
    });
    expect(capture).toHaveLength(1);
    expect(capture[0]!.port).toBe(9876);
    expect(capture[0]!.hostname).toBe('127.0.0.1');
    const bootLog = logs.find((l) => l.includes('shim.boot'));
    expect(bootLog).toBeDefined();
    const parsed = JSON.parse(bootLog!);
    expect(parsed).toMatchObject({
      event: 'shim.boot',
      port: 9876,
      hostname: '127.0.0.1',
    });
  });

  test('wires the fetch handler that responds to /health', async () => {
    const { serve, capture } = makeFakeServe();
    boot({
      env: {},
      serve,
      soffice: {
        async run() {
          return { exitCode: 0, timedOut: false };
        },
      },
      fs: {
        async mkdtemp(prefix) {
          return `${prefix}fake`;
        },
        async writeFile() {},
        async readFile() {
          return new Uint8Array([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x64, 0x00, 0x00, 0x00, 0x64,
          ]);
        },
        async readdir() {
          return ['in.png'];
        },
        async rm() {},
      },
      log: () => {},
    });
    const res = await capture[0]!.fetch(new Request('http://localhost/health'));
    expect(res.status).toBe(200);
  });

  test('error handler returns a redacted 500 envelope', async () => {
    const { serve, capture } = makeFakeServe();
    boot({
      env: {},
      serve,
      soffice: {
        async run() {
          return { exitCode: 1, timedOut: false };
        },
      },
      log: () => {},
    });
    const res = capture[0]!.error(new Error('something exploded internally'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(body)).not.toContain('exploded');
  });

  test('stop() forwards to the returned handle', () => {
    const { serve, stopCalls } = makeFakeServe();
    const handle = boot({
      env: {},
      serve,
      soffice: {
        async run() {
          return { exitCode: 0, timedOut: false };
        },
      },
      log: () => {},
    });
    expect(stopCalls).toEqual([]);
    handle.stop();
    expect(stopCalls).toEqual([0]);
  });

  test('config returned by boot() matches the resolved env', () => {
    const { serve } = makeFakeServe();
    const handle = boot({
      env: { STORAGE_SIDECAR_PORT: '7777', STORAGE_SIDECAR_TIMEOUT_MS: '12000' },
      serve,
      soffice: {
        async run() {
          return { exitCode: 0, timedOut: false };
        },
      },
      log: () => {},
    });
    expect(handle.config.port).toBe(7777);
    expect(handle.config.timeoutMs).toBe(12_000);
  });
});
