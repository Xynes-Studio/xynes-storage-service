/**
 * STORAGE-FU-5-FU-G — health tests.
 *
 * `createHealthChecker` caches a probe result for TTL_MS and shares
 * the in-flight promise across concurrent callers.
 */
import { describe, expect, test } from 'bun:test';

import { createHealthChecker, type HealthSnapshot } from '../src/health';
import type { ConvertDeps, FsPort, SofficeRunner } from '../src/convert';
import { pngBytesForTest } from './_test-helpers';

function makeOkDeps(): ConvertDeps {
  const okFs: FsPort = {
    async mkdtemp(prefix) {
      return `${prefix}fake`;
    },
    async writeFile() {},
    async readFile() {
      return pngBytesForTest(100, 100);
    },
    async readdir() {
      return ['in.png'];
    },
    async rm() {},
  };
  const okRunner: SofficeRunner = {
    async run() {
      return { exitCode: 0, timedOut: false };
    },
  };
  return {
    fs: okFs,
    soffice: okRunner,
    tmpRoot: '/tmp',
    timeoutMs: 30_000,
    newId: () => 'fake',
  };
}

function makeFailDeps(): ConvertDeps {
  return {
    ...makeOkDeps(),
    soffice: {
      async run() {
        return { exitCode: 1, timedOut: false };
      },
    },
  };
}

describe('createHealthChecker', () => {
  test('successful probe returns status=ok', async () => {
    const checker = createHealthChecker(makeOkDeps());
    const snap = await checker.check();
    expect(snap.status).toBe('ok');
  });

  test('failed probe returns status=degraded', async () => {
    const checker = createHealthChecker(makeFailDeps());
    const snap = await checker.check();
    expect(snap.status).toBe('degraded');
  });

  test('cached result is reused within TTL', async () => {
    let probeCount = 0;
    const deps: ConvertDeps = {
      ...makeOkDeps(),
      soffice: {
        async run() {
          probeCount++;
          return { exitCode: 0, timedOut: false };
        },
      },
    };
    let now = 1_000_000;
    const checker = createHealthChecker(deps, { now: () => now, ttlMs: 5_000 });

    await checker.check();
    await checker.check();
    await checker.check();
    expect(probeCount).toBe(1);

    // Advance past TTL — next check re-probes.
    now += 6_000;
    await checker.check();
    expect(probeCount).toBe(2);
  });

  test('concurrent callers share the in-flight probe', async () => {
    let probeCount = 0;
    let resolveProbe: (() => void) | null = null;
    const deps: ConvertDeps = {
      ...makeOkDeps(),
      soffice: {
        async run() {
          probeCount++;
          await new Promise<void>((resolve) => {
            resolveProbe = resolve;
          });
          return { exitCode: 0, timedOut: false };
        },
      },
    };
    const checker = createHealthChecker(deps);
    const a = checker.check();
    const b = checker.check();
    const c = checker.check();
    // Give the first call time to enter `soffice.run()`.
    await new Promise((r) => setTimeout(r, 5));
    expect(probeCount).toBe(1);
    resolveProbe!();
    await Promise.all([a, b, c]);
    expect(probeCount).toBe(1);
  });

  test('invalidate() forces re-probe on next check', async () => {
    let probeCount = 0;
    const deps: ConvertDeps = {
      ...makeOkDeps(),
      soffice: {
        async run() {
          probeCount++;
          return { exitCode: 0, timedOut: false };
        },
      },
    };
    const checker = createHealthChecker(deps);
    await checker.check();
    expect(probeCount).toBe(1);
    checker.invalidate();
    await checker.check();
    expect(probeCount).toBe(2);
  });

  test('current() returns cached snapshot or null when no probe has run', async () => {
    const checker = createHealthChecker(makeOkDeps());
    expect(checker.current()).toBeNull();
    const snap: HealthSnapshot = await checker.check();
    expect(checker.current()).toEqual(snap);
  });
});
