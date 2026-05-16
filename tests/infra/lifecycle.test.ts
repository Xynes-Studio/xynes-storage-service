/**
 * STORAGE-FU-6 — worker lifecycle wiring tests.
 *
 * These tests cover (per
 * `xynes-infra/docs/plans/archive/2026-05-14-storage-register-handlers-and-drizzle-wiring.md`
 * §9):
 *
 *   1. Worker polling defaults (5 s) + override via
 *      `STORAGE_WORKER_POLL_INTERVAL_MS`.
 *   2. Cleanup polling defaults (60 s) + override via
 *      `STORAGE_CLEANUP_INTERVAL_MS`.
 *   3. `worker.start()` and `cleanup.start()` are called exactly once
 *      after composition, with the resolved intervals.
 *   4. `SIGTERM` / `SIGINT` handlers drain + tear down + exit cleanly.
 *   5. Shutdown is idempotent — a second signal collapses to one
 *      shutdown.
 *   6. `lifecycle.started` log entry carries only the resolved intervals
 *      (no env values, no `DATABASE_URL`, no credentials).
 *   7. `worker.start` or `cleanup.start` throwing does NOT crash the
 *      bootstrap path.
 *   8. Worker concurrency caps (`STORAGE_WORKER_MAX_CONCURRENT` /
 *      `STORAGE_WORKER_MAX_PER_WORKSPACE`) are forwarded to the
 *      `ProcessingWorker` constructor via `buildComposition`.
 *
 * Tests deliberately use fake signal handler / `onShutdownComplete` /
 * timeout hooks so we never send a real `SIGTERM` or call
 * `process.exit` during the test run.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  LIFECYCLE_SIGNALS,
  parsePositiveIntMs,
  resolveLifecycleConfig,
  startLifecycle,
  type LifecycleSignal,
} from '../../src/infra/lifecycle';
import { buildComposition } from '../../src/composition';
import { __resetRegistry } from '../../src/actions/registry';
import type { CompositionRoot } from '../../src/composition';
import type { StorageDbClient } from '../../src/infra/db/client';
import type { SecretManagerClient } from '../../src/infra/providers/secret-manager';

// ── Fakes ─────────────────────────────────────────────────────────────────

function makeFakeDbClient(): { client: StorageDbClient; closeCount: () => number } {
  let closeCalls = 0;
  return {
    client: {
      db: {} as never,
      client: {} as never,
      close: async () => {
        closeCalls += 1;
      },
    },
    closeCount: () => closeCalls,
  };
}

const FAKE_SECRETS: SecretManagerClient = {
  async resolve() {
    throw new Error('not called in lifecycle tests');
  },
};

function buildTestComposition(extraEnv: NodeJS.ProcessEnv = {}): {
  composition: CompositionRoot;
  closeCount: () => number;
} {
  const { client, closeCount } = makeFakeDbClient();
  const composition = buildComposition({
    env: { DATABASE_URL: 'postgres://fake', ...extraEnv },
    secrets: FAKE_SECRETS,
    dbClient: client,
  });
  return { composition, closeCount };
}

interface SignalRegistry {
  register: (signal: LifecycleSignal, handler: () => void) => void;
  unregister: (signal: LifecycleSignal, handler: () => void) => void;
  dispatch: (signal: LifecycleSignal) => void;
  isRegistered: (signal: LifecycleSignal) => boolean;
}

function makeFakeSignalRegistry(): SignalRegistry {
  const handlers = new Map<LifecycleSignal, Set<() => void>>();
  return {
    register: (signal, handler) => {
      const set = handlers.get(signal) ?? new Set();
      set.add(handler);
      handlers.set(signal, set);
    },
    unregister: (signal, handler) => {
      handlers.get(signal)?.delete(handler);
    },
    dispatch: (signal) => {
      const set = handlers.get(signal);
      if (!set) return;
      // Copy so a handler unregistering itself does not break iteration.
      for (const h of [...set]) h();
    },
    isRegistered: (signal) => {
      const set = handlers.get(signal);
      return set !== undefined && set.size > 0;
    },
  };
}

// ── Log capture ───────────────────────────────────────────────────────────

interface CapturedLog {
  readonly message: string;
  readonly level: string;
  readonly event?: string;
  readonly serialized: string;
  readonly parsed: Record<string, unknown>;
}

const originalConsoleLog = console.log;
let captured: CapturedLog[] = [];

beforeEach(() => {
  captured = [];
  console.log = (line: unknown) => {
    if (typeof line !== 'string') return;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      captured.push({
        message: String(parsed.message ?? ''),
        level: String(parsed.level ?? ''),
        event: parsed.event ? String(parsed.event) : undefined,
        serialized: line,
        parsed,
      });
    } catch {
      // Non-JSON output — ignore.
    }
  };
  __resetRegistry();
});

afterEach(() => {
  console.log = originalConsoleLog;
  __resetRegistry();
});

// ── parsePositiveIntMs ────────────────────────────────────────────────────

describe('STORAGE-FU-6 parsePositiveIntMs', () => {
  test('returns fallback for undefined', () => {
    expect(parsePositiveIntMs(undefined, 5000)).toBe(5000);
  });

  test('returns fallback for empty string', () => {
    expect(parsePositiveIntMs('', 5000)).toBe(5000);
  });

  test('returns fallback for whitespace', () => {
    expect(parsePositiveIntMs('   ', 5000)).toBe(5000);
  });

  test('returns fallback for non-numeric', () => {
    expect(parsePositiveIntMs('abc', 5000)).toBe(5000);
  });

  test('returns fallback for zero', () => {
    expect(parsePositiveIntMs('0', 5000)).toBe(5000);
  });

  test('returns fallback for negative', () => {
    expect(parsePositiveIntMs('-10', 5000)).toBe(5000);
  });

  test('returns the parsed value when valid', () => {
    expect(parsePositiveIntMs('1234', 5000)).toBe(1234);
  });

  test('trims whitespace before parsing', () => {
    expect(parsePositiveIntMs('  2500  ', 5000)).toBe(2500);
  });

  // Codex P1 review on PR #14: strict integer semantics. The previous
  // implementation used `Number.parseInt` which silently truncated
  // floats, scientific notation, and trailing-garbage strings to
  // tiny ints (e.g. `"1e3"` → 1, `"3.14"` → 3, `"5000ms"` → 5000).
  // These regression guards lock in the strict-int contract documented
  // in the docstring.
  test('returns fallback for floats (Codex P1: prevents 3.14 → 3)', () => {
    expect(parsePositiveIntMs('3.14', 5000)).toBe(5000);
    expect(parsePositiveIntMs('1.99', 5000)).toBe(5000);
    expect(parsePositiveIntMs('0.5', 5000)).toBe(5000);
  });

  test('returns fallback for scientific notation (Codex P1: prevents 1e3 → 1)', () => {
    expect(parsePositiveIntMs('1e3', 5000)).toBe(5000);
    expect(parsePositiveIntMs('2E5', 5000)).toBe(5000);
  });

  test('returns fallback for trailing garbage (Codex P1: prevents 5000ms → 5000)', () => {
    expect(parsePositiveIntMs('5000ms', 5000)).toBe(5000);
    expect(parsePositiveIntMs('60s', 5000)).toBe(5000);
    expect(parsePositiveIntMs('100 ', 5000)).toBe(100); // trailing whitespace ONLY is allowed (trim)
    expect(parsePositiveIntMs('123abc', 5000)).toBe(5000);
  });

  test('returns fallback for unsafe integer overflow', () => {
    // Number.MAX_SAFE_INTEGER is 2^53 - 1 = 9007199254740991
    expect(parsePositiveIntMs('99999999999999999999', 5000)).toBe(5000);
    expect(parsePositiveIntMs('9999999999999999999', 5000)).toBe(5000);
  });

  test('returns fallback for embedded whitespace or signs', () => {
    expect(parsePositiveIntMs('1 000', 5000)).toBe(5000);
    expect(parsePositiveIntMs('+100', 5000)).toBe(5000);
    expect(parsePositiveIntMs('--5', 5000)).toBe(5000);
  });
});

// ── resolveLifecycleConfig ────────────────────────────────────────────────

describe('STORAGE-FU-6 resolveLifecycleConfig', () => {
  test('uses 5s worker / 60s cleanup / 30s shutdown defaults when env is empty', () => {
    const cfg = resolveLifecycleConfig({});
    expect(cfg.workerPollIntervalMs).toBe(5_000);
    expect(cfg.cleanupPollIntervalMs).toBe(60_000);
    expect(cfg.gracefulShutdownTimeoutMs).toBe(30_000);
  });

  test('honours STORAGE_WORKER_POLL_INTERVAL_MS override', () => {
    const cfg = resolveLifecycleConfig({ STORAGE_WORKER_POLL_INTERVAL_MS: '1234' });
    expect(cfg.workerPollIntervalMs).toBe(1234);
  });

  test('honours STORAGE_CLEANUP_INTERVAL_MS override', () => {
    const cfg = resolveLifecycleConfig({ STORAGE_CLEANUP_INTERVAL_MS: '7777' });
    expect(cfg.cleanupPollIntervalMs).toBe(7777);
  });

  test('honours STORAGE_SHUTDOWN_TIMEOUT_MS override', () => {
    const cfg = resolveLifecycleConfig({ STORAGE_SHUTDOWN_TIMEOUT_MS: '15000' });
    expect(cfg.gracefulShutdownTimeoutMs).toBe(15_000);
  });

  test('falls back to defaults on invalid override values', () => {
    const cfg = resolveLifecycleConfig({
      STORAGE_WORKER_POLL_INTERVAL_MS: 'abc',
      STORAGE_CLEANUP_INTERVAL_MS: '-100',
      STORAGE_SHUTDOWN_TIMEOUT_MS: '0',
    });
    expect(cfg.workerPollIntervalMs).toBe(5_000);
    expect(cfg.cleanupPollIntervalMs).toBe(60_000);
    expect(cfg.gracefulShutdownTimeoutMs).toBe(30_000);
  });
});

// ── startLifecycle: worker + cleanup start ────────────────────────────────

describe('STORAGE-FU-6 startLifecycle — start phase', () => {
  test('starts worker and cleanup with resolved intervals from env', async () => {
    const { composition } = buildTestComposition();
    const workerStartCalls: number[] = [];
    const cleanupStartCalls: number[] = [];
    composition.worker.start = ((ms?: number) => {
      workerStartCalls.push(ms ?? -1);
    }) as typeof composition.worker.start;
    composition.cleanup.start = ((ms?: number) => {
      cleanupStartCalls.push(ms ?? -1);
    }) as typeof composition.cleanup.start;

    const signals = makeFakeSignalRegistry();
    const handle = startLifecycle(composition, {
      env: {
        STORAGE_WORKER_POLL_INTERVAL_MS: '2500',
        STORAGE_CLEANUP_INTERVAL_MS: '30000',
      },
      registerSignalHandler: signals.register,
      removeSignalHandler: signals.unregister,
      onShutdownComplete: () => {},
    });

    expect(workerStartCalls).toEqual([2500]);
    expect(cleanupStartCalls).toEqual([30_000]);
    expect(handle.config.workerPollIntervalMs).toBe(2500);
    expect(handle.config.cleanupPollIntervalMs).toBe(30_000);
    await handle.stop();
  });

  test('uses default intervals (5s / 60s) when env is unset', async () => {
    const { composition } = buildTestComposition();
    const workerStartCalls: number[] = [];
    const cleanupStartCalls: number[] = [];
    composition.worker.start = ((ms?: number) => {
      workerStartCalls.push(ms ?? -1);
    }) as typeof composition.worker.start;
    composition.cleanup.start = ((ms?: number) => {
      cleanupStartCalls.push(ms ?? -1);
    }) as typeof composition.cleanup.start;

    const signals = makeFakeSignalRegistry();
    const handle = startLifecycle(composition, {
      env: {},
      registerSignalHandler: signals.register,
      removeSignalHandler: signals.unregister,
      onShutdownComplete: () => {},
    });

    expect(workerStartCalls).toEqual([5_000]);
    expect(cleanupStartCalls).toEqual([60_000]);
    await handle.stop();
  });

  test('registers SIGTERM and SIGINT handlers exactly once each', async () => {
    const { composition } = buildTestComposition();
    composition.worker.start = (() => {}) as typeof composition.worker.start;
    composition.cleanup.start = (() => {}) as typeof composition.cleanup.start;

    const signals = makeFakeSignalRegistry();
    const handle = startLifecycle(composition, {
      env: {},
      registerSignalHandler: signals.register,
      removeSignalHandler: signals.unregister,
      onShutdownComplete: () => {},
    });

    for (const sig of LIFECYCLE_SIGNALS) {
      expect(signals.isRegistered(sig)).toBe(true);
    }
    await handle.stop();
  });

  test('emits storage.lifecycle.started log entry with resolved intervals only', async () => {
    const { composition } = buildTestComposition();
    composition.worker.start = (() => {}) as typeof composition.worker.start;
    composition.cleanup.start = (() => {}) as typeof composition.cleanup.start;

    captured = [];
    const signals = makeFakeSignalRegistry();
    const handle = startLifecycle(composition, {
      env: {
        DATABASE_URL: 'postgres://alice:s3cret@db.internal:5432/storage',
        STORAGE_CREDENTIAL_PROD_ACCESS_KEY_ID: 'AKIA-LEAK-1234',
        STORAGE_CREDENTIAL_PROD_SECRET_ACCESS_KEY: 'leak-secret-do-not-emit',
        STORAGE_WORKER_POLL_INTERVAL_MS: '3000',
        STORAGE_CLEANUP_INTERVAL_MS: '90000',
        STORAGE_SHUTDOWN_TIMEOUT_MS: '20000',
      },
      registerSignalHandler: signals.register,
      removeSignalHandler: signals.unregister,
      onShutdownComplete: () => {},
    });

    const startedEntries = captured.filter((e) => e.event === 'storage.lifecycle.started');
    expect(startedEntries.length).toBe(1);
    const parsed = startedEntries[0]!.parsed;
    expect(parsed.workerPollIntervalMs).toBe(3000);
    expect(parsed.cleanupPollIntervalMs).toBe(90_000);
    expect(parsed.gracefulShutdownTimeoutMs).toBe(20_000);

    // Allowlist invariant — every key on the entry is documented.
    const allowed = new Set([
      'ts',
      'level',
      'service',
      'message',
      'event',
      'workerPollIntervalMs',
      'cleanupPollIntervalMs',
      'gracefulShutdownTimeoutMs',
    ]);
    for (const key of Object.keys(parsed)) {
      expect(allowed.has(key)).toBe(true);
    }

    // Hostile substrings MUST NOT appear in the entry.
    const serialized = startedEntries[0]!.serialized;
    expect(serialized).not.toContain('alice');
    expect(serialized).not.toContain('s3cret');
    expect(serialized).not.toContain('AKIA-LEAK-1234');
    expect(serialized).not.toContain('leak-secret-do-not-emit');
    expect(serialized).not.toContain('db.internal');

    await handle.stop();
  });

  test('worker.start throwing does not block lifecycle bootstrap', async () => {
    const { composition } = buildTestComposition();
    composition.worker.start = (() => {
      throw new Error('boom');
    }) as typeof composition.worker.start;
    let cleanupStarted = false;
    composition.cleanup.start = (() => {
      cleanupStarted = true;
    }) as typeof composition.cleanup.start;

    const signals = makeFakeSignalRegistry();
    const handle = startLifecycle(composition, {
      env: {},
      registerSignalHandler: signals.register,
      removeSignalHandler: signals.unregister,
      onShutdownComplete: () => {},
    });

    // Cleanup must still start.
    expect(cleanupStarted).toBe(true);
    // A storage.worker.start_failed log entry must be emitted with the
    // closed-set errorName field only (no raw message text).
    const failed = captured.filter((e) => e.event === 'storage.worker.start_failed');
    expect(failed.length).toBe(1);
    expect(failed[0]!.parsed.errorName).toBe('Error');
    expect(failed[0]!.serialized).not.toContain('boom');

    await handle.stop();
  });

  test('cleanup.start throwing does not block lifecycle bootstrap', async () => {
    const { composition } = buildTestComposition();
    let workerStarted = false;
    composition.worker.start = (() => {
      workerStarted = true;
    }) as typeof composition.worker.start;
    composition.cleanup.start = (() => {
      throw new Error('cleanup boom');
    }) as typeof composition.cleanup.start;

    const signals = makeFakeSignalRegistry();
    const handle = startLifecycle(composition, {
      env: {},
      registerSignalHandler: signals.register,
      removeSignalHandler: signals.unregister,
      onShutdownComplete: () => {},
    });

    expect(workerStarted).toBe(true);
    const failed = captured.filter((e) => e.event === 'storage.cleanup.start_failed');
    expect(failed.length).toBe(1);
    expect(failed[0]!.serialized).not.toContain('cleanup boom');

    await handle.stop();
  });
});

// ── startLifecycle: shutdown phase ────────────────────────────────────────

describe('STORAGE-FU-6 startLifecycle — shutdown phase', () => {
  test('SIGTERM stops workers, awaits composition.shutdown, calls onShutdownComplete(0)', async () => {
    const { composition, closeCount } = buildTestComposition();
    composition.worker.start = (() => {}) as typeof composition.worker.start;
    composition.cleanup.start = (() => {}) as typeof composition.cleanup.start;

    let exitCode = -1;
    const signals = makeFakeSignalRegistry();
    startLifecycle(composition, {
      env: {},
      registerSignalHandler: signals.register,
      removeSignalHandler: signals.unregister,
      onShutdownComplete: (code) => {
        exitCode = code;
      },
    });

    // Dispatch SIGTERM and let the async shutdown chain settle.
    signals.dispatch('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(exitCode).toBe(0);
    // Composition owns the DB — shutdown should close it. Our injected
    // dbClient is caller-owned, so closeCount stays 0; we instead
    // verify the shutdown chain ran by asserting the lifecycle
    // shutdown log entry was emitted.
    expect(closeCount()).toBe(0); // injected client is caller-owned
    const shutdownEntries = captured.filter((e) => e.event === 'storage.lifecycle.shutdown');
    expect(shutdownEntries.length).toBe(1);
    expect(shutdownEntries[0]!.parsed.signal).toBe('SIGTERM');
  });

  test('SIGINT triggers the same shutdown path', async () => {
    const { composition } = buildTestComposition();
    composition.worker.start = (() => {}) as typeof composition.worker.start;
    composition.cleanup.start = (() => {}) as typeof composition.cleanup.start;

    let exitCode = -1;
    const signals = makeFakeSignalRegistry();
    startLifecycle(composition, {
      env: {},
      registerSignalHandler: signals.register,
      removeSignalHandler: signals.unregister,
      onShutdownComplete: (code) => {
        exitCode = code;
      },
    });

    signals.dispatch('SIGINT');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(exitCode).toBe(0);
    const shutdownEntries = captured.filter((e) => e.event === 'storage.lifecycle.shutdown');
    expect(shutdownEntries.length).toBe(1);
    expect(shutdownEntries[0]!.parsed.signal).toBe('SIGINT');
  });

  test('shutdown stops worker AND cleanup before tearing down composition', async () => {
    const { composition } = buildTestComposition();
    composition.worker.start = (() => {}) as typeof composition.worker.start;
    composition.cleanup.start = (() => {}) as typeof composition.cleanup.start;

    const order: string[] = [];
    composition.worker.stop = (() => {
      order.push('worker.stop');
    }) as typeof composition.worker.stop;
    composition.cleanup.stop = (() => {
      order.push('cleanup.stop');
    }) as typeof composition.cleanup.stop;
    const originalShutdown = composition.shutdown;
    (composition as { shutdown: () => Promise<void> }).shutdown = async () => {
      order.push('composition.shutdown');
      await originalShutdown();
    };

    let exitCode = -1;
    const signals = makeFakeSignalRegistry();
    startLifecycle(composition, {
      env: {},
      registerSignalHandler: signals.register,
      removeSignalHandler: signals.unregister,
      onShutdownComplete: (code) => {
        exitCode = code;
      },
    });

    signals.dispatch('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(exitCode).toBe(0);
    expect(order.indexOf('worker.stop')).toBeLessThan(order.indexOf('composition.shutdown'));
    expect(order.indexOf('cleanup.stop')).toBeLessThan(order.indexOf('composition.shutdown'));
  });

  test('double SIGTERM collapses to one shutdown (idempotent)', async () => {
    const { composition } = buildTestComposition();
    composition.worker.start = (() => {}) as typeof composition.worker.start;
    composition.cleanup.start = (() => {}) as typeof composition.cleanup.start;

    let shutdownCalls = 0;
    const originalShutdown = composition.shutdown;
    (composition as { shutdown: () => Promise<void> }).shutdown = async () => {
      shutdownCalls += 1;
      await originalShutdown();
    };

    let exitCalls = 0;
    const signals = makeFakeSignalRegistry();
    startLifecycle(composition, {
      env: {},
      registerSignalHandler: signals.register,
      removeSignalHandler: signals.unregister,
      onShutdownComplete: () => {
        exitCalls += 1;
      },
    });

    signals.dispatch('SIGTERM');
    signals.dispatch('SIGTERM');
    signals.dispatch('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(shutdownCalls).toBe(1);
    // Each signal dispatch still fires `onShutdownComplete` once when its
    // promise settles, but they all resolve to the same single shutdown
    // promise — the work is only done once.
    expect(exitCalls).toBeGreaterThanOrEqual(1);
  });

  test('explicit stop() triggers shutdown without process.exit', async () => {
    const { composition } = buildTestComposition();
    composition.worker.start = (() => {}) as typeof composition.worker.start;
    composition.cleanup.start = (() => {}) as typeof composition.cleanup.start;

    let exitCalls = 0;
    const signals = makeFakeSignalRegistry();
    const handle = startLifecycle(composition, {
      env: {},
      registerSignalHandler: signals.register,
      removeSignalHandler: signals.unregister,
      onShutdownComplete: () => {
        exitCalls += 1;
      },
    });

    await handle.stop();

    expect(exitCalls).toBe(0); // explicit stop should NOT call process.exit
    const shutdownEntries = captured.filter((e) => e.event === 'storage.lifecycle.shutdown');
    expect(shutdownEntries.length).toBe(1);
    expect(shutdownEntries[0]!.parsed.signal).toBe('explicit');
  });

  test('shutdown timeout fires when composition.shutdown hangs', async () => {
    const { composition } = buildTestComposition();
    composition.worker.start = (() => {}) as typeof composition.worker.start;
    composition.cleanup.start = (() => {}) as typeof composition.cleanup.start;
    // Make composition.shutdown hang.
    (composition as { shutdown: () => Promise<void> }).shutdown = () =>
      new Promise(() => {
        /* never resolves */
      });

    let timeoutFired = false;
    const fakeSetTimeout = (handler: () => void, _ms: number): NodeJS.Timeout => {
      // Immediately fire the timeout to simulate elapsed time.
      timeoutFired = true;
      // Drive the timeout in a microtask so the Promise.race tasks
      // both register before we resolve.
      queueMicrotask(handler);
      return null as unknown as NodeJS.Timeout;
    };

    let exitCalls = 0;
    const signals = makeFakeSignalRegistry();
    startLifecycle(composition, {
      env: { STORAGE_SHUTDOWN_TIMEOUT_MS: '50' },
      registerSignalHandler: signals.register,
      removeSignalHandler: signals.unregister,
      onShutdownComplete: () => {
        exitCalls += 1;
      },
      setTimeoutFn: fakeSetTimeout,
      clearTimeoutFn: () => {},
    });

    signals.dispatch('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(timeoutFired).toBe(true);
    const timeoutEntries = captured.filter((e) => e.event === 'storage.lifecycle.shutdown_timeout');
    expect(timeoutEntries.length).toBe(1);
    expect(timeoutEntries[0]!.parsed.gracefulShutdownTimeoutMs).toBe(50);
    // We still report the shutdown as complete (best-effort).
    expect(exitCalls).toBeGreaterThanOrEqual(1);
  });

  test('composition.shutdown throwing surfaces as shutdown_failed log entry', async () => {
    const { composition } = buildTestComposition();
    composition.worker.start = (() => {}) as typeof composition.worker.start;
    composition.cleanup.start = (() => {}) as typeof composition.cleanup.start;
    (composition as { shutdown: () => Promise<void> }).shutdown = async () => {
      throw new Error('boom-from-shutdown');
    };

    let exitCalls = 0;
    const signals = makeFakeSignalRegistry();
    startLifecycle(composition, {
      env: {},
      registerSignalHandler: signals.register,
      removeSignalHandler: signals.unregister,
      onShutdownComplete: () => {
        exitCalls += 1;
      },
    });

    signals.dispatch('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 10));

    const failedEntries = captured.filter((e) => e.event === 'storage.lifecycle.shutdown_failed');
    expect(failedEntries.length).toBe(1);
    expect(failedEntries[0]!.serialized).not.toContain('boom-from-shutdown');
    expect(failedEntries[0]!.parsed.errorName).toBe('Error');
    expect(exitCalls).toBeGreaterThanOrEqual(1);
  });

  test('worker.stop() throwing is swallowed and logged as worker.stop_failed', async () => {
    const { composition } = buildTestComposition();
    composition.worker.start = (() => {}) as typeof composition.worker.start;
    composition.cleanup.start = (() => {}) as typeof composition.cleanup.start;
    composition.worker.stop = (() => {
      throw new Error('boom-from-worker-stop');
    }) as typeof composition.worker.stop;
    let cleanupStopCalls = 0;
    composition.cleanup.stop = (() => {
      cleanupStopCalls += 1;
    }) as typeof composition.cleanup.stop;
    (composition as { shutdown: () => Promise<void> }).shutdown = async () => {};

    let exitCalls = 0;
    const signals = makeFakeSignalRegistry();
    startLifecycle(composition, {
      env: {},
      registerSignalHandler: signals.register,
      removeSignalHandler: signals.unregister,
      onShutdownComplete: () => {
        exitCalls += 1;
      },
    });

    signals.dispatch('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Worker.stop threw — but cleanup.stop still ran AND the shutdown
    // completed cleanly (exit code 0, not 1).
    const failedEntries = captured.filter((e) => e.event === 'storage.worker.stop_failed');
    expect(failedEntries.length).toBe(1);
    expect(failedEntries[0]!.parsed.errorName).toBe('Error');
    // No raw exception text leaks.
    expect(failedEntries[0]!.serialized).not.toContain('boom-from-worker-stop');
    expect(cleanupStopCalls).toBe(1);
    expect(exitCalls).toBeGreaterThanOrEqual(1);
  });

  test('cleanup.stop() throwing is swallowed and logged as cleanup.stop_failed', async () => {
    const { composition } = buildTestComposition();
    composition.worker.start = (() => {}) as typeof composition.worker.start;
    composition.cleanup.start = (() => {}) as typeof composition.cleanup.start;
    let workerStopCalls = 0;
    composition.worker.stop = (() => {
      workerStopCalls += 1;
    }) as typeof composition.worker.stop;
    composition.cleanup.stop = (() => {
      throw new Error('boom-from-cleanup-stop');
    }) as typeof composition.cleanup.stop;
    (composition as { shutdown: () => Promise<void> }).shutdown = async () => {};

    let exitCalls = 0;
    const signals = makeFakeSignalRegistry();
    startLifecycle(composition, {
      env: {},
      registerSignalHandler: signals.register,
      removeSignalHandler: signals.unregister,
      onShutdownComplete: () => {
        exitCalls += 1;
      },
    });

    signals.dispatch('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Worker.stop ran. Cleanup.stop threw but was swallowed.
    expect(workerStopCalls).toBe(1);
    const failedEntries = captured.filter((e) => e.event === 'storage.cleanup.stop_failed');
    expect(failedEntries.length).toBe(1);
    expect(failedEntries[0]!.parsed.errorName).toBe('Error');
    expect(failedEntries[0]!.serialized).not.toContain('boom-from-cleanup-stop');
    expect(exitCalls).toBeGreaterThanOrEqual(1);
  });

  test('registerSignalHandler throwing degrades silently (signal-less env)', async () => {
    const { composition } = buildTestComposition();
    composition.worker.start = (() => {}) as typeof composition.worker.start;
    composition.cleanup.start = (() => {}) as typeof composition.cleanup.start;

    const handle = startLifecycle(composition, {
      env: {},
      registerSignalHandler: () => {
        throw new Error('no signals here');
      },
      removeSignalHandler: () => {},
      onShutdownComplete: () => {},
    });

    // Explicit stop should still work even when signal registration failed.
    await handle.stop();
  });
});

// ── Composition wiring: env-driven worker concurrency caps ────────────────

describe('STORAGE-FU-6 buildComposition — worker concurrency env', () => {
  test('forwards STORAGE_WORKER_MAX_CONCURRENT to ProcessingWorker', () => {
    // We rely on the worker exposing its caps through behaviour rather
    // than a private field. The cleanest end-to-end assertion is: the
    // composition root accepts the env value without throwing, and the
    // worker instance was constructed. The actual cap-enforcement is
    // covered by STORAGE-7 worker unit tests; here we just prove the
    // env is plumbed through to the constructor without error.
    const { client } = makeFakeDbClient();
    expect(() =>
      buildComposition({
        env: {
          DATABASE_URL: 'postgres://fake',
          STORAGE_WORKER_MAX_CONCURRENT: '8',
          STORAGE_WORKER_MAX_PER_WORKSPACE: '4',
        },
        secrets: FAKE_SECRETS,
        dbClient: client,
      }),
    ).not.toThrow();
  });

  test('falls through to defaults when STORAGE_WORKER_MAX_* are blank or invalid', () => {
    const { client } = makeFakeDbClient();
    expect(() =>
      buildComposition({
        env: {
          DATABASE_URL: 'postgres://fake',
          STORAGE_WORKER_MAX_CONCURRENT: '',
          STORAGE_WORKER_MAX_PER_WORKSPACE: '-1',
        },
        secrets: FAKE_SECRETS,
        dbClient: client,
      }),
    ).not.toThrow();
  });

  // Codex P2 review on PR #14: strict integer semantics on worker caps.
  // The previous parser used `Number.parseInt` which silently truncated
  // floats / scientific notation / trailing-garbage strings into tiny
  // ints (e.g. `STORAGE_WORKER_MAX_CONCURRENT="1e3"` would have become
  // 1 instead of falling through to the STORAGE-7 default of 4). These
  // tests inspect the constructed `ProcessingWorker`'s private fields
  // via a TS cast to lock in the documented "invalid → default" contract.
  test('rejects floats and scientific notation for worker caps (Codex P2)', () => {
    const { client } = makeFakeDbClient();
    const root = buildComposition({
      env: {
        DATABASE_URL: 'postgres://fake',
        STORAGE_WORKER_MAX_CONCURRENT: '1e3', // would silently become 1 under the old parser
        STORAGE_WORKER_MAX_PER_WORKSPACE: '3.14', // would silently become 3
      },
      secrets: FAKE_SECRETS,
      dbClient: client,
    });
    const worker = root.worker as unknown as {
      maxConcurrent: number;
      maxPerWorkspace: number;
    };
    // Both fall through to the STORAGE-7 worker defaults (4 / 2), NOT
    // the silently-truncated values (1 / 3).
    expect(worker.maxConcurrent).toBe(4);
    expect(worker.maxPerWorkspace).toBe(2);
  });

  test('rejects trailing-garbage strings for worker caps (Codex P2)', () => {
    const { client } = makeFakeDbClient();
    const root = buildComposition({
      env: {
        DATABASE_URL: 'postgres://fake',
        STORAGE_WORKER_MAX_CONCURRENT: '8 workers',
        STORAGE_WORKER_MAX_PER_WORKSPACE: '2x',
      },
      secrets: FAKE_SECRETS,
      dbClient: client,
    });
    const worker = root.worker as unknown as {
      maxConcurrent: number;
      maxPerWorkspace: number;
    };
    expect(worker.maxConcurrent).toBe(4);
    expect(worker.maxPerWorkspace).toBe(2);
  });

  test('accepts a clean integer override for worker caps', () => {
    const { client } = makeFakeDbClient();
    const root = buildComposition({
      env: {
        DATABASE_URL: 'postgres://fake',
        STORAGE_WORKER_MAX_CONCURRENT: '8',
        STORAGE_WORKER_MAX_PER_WORKSPACE: '4',
      },
      secrets: FAKE_SECRETS,
      dbClient: client,
    });
    const worker = root.worker as unknown as {
      maxConcurrent: number;
      maxPerWorkspace: number;
    };
    expect(worker.maxConcurrent).toBe(8);
    expect(worker.maxPerWorkspace).toBe(4);
  });
});
