/**
 * STORAGE-FU-6 — worker lifecycle wiring for `xynes-storage-service`.
 *
 * Responsibilities (per
 * `xynes-infra/docs/plans/2026-05-14-storage-register-handlers-and-drizzle-wiring.md`
 * §9):
 *
 *   1. Resolve the polling intervals for the `ProcessingWorker` and
 *      `AbandonedUploadCleanup` from env, with conservative defaults
 *      that match the acceptance criteria (5 s worker, 60 s cleanup).
 *   2. Call `worker.start(intervalMs)` and `cleanup.start(intervalMs)`
 *      AFTER `buildComposition` has registered every handler.
 *   3. Register `SIGTERM` / `SIGINT` handlers that stop the polling
 *      loops, await any in-flight `runOnce` drains, and tear down the
 *      composition (closes the owned DB pool). Once shutdown completes
 *      the handler exits the process with code 0 — matches sibling
 *      services (`xynes-accounts-service`, `xynes-cms-core`).
 *   4. Stay idempotent. A second `SIGTERM` while shutdown is in flight
 *      must NOT trigger a parallel shutdown.
 *
 * Worker errors NEVER crash the service (STORAGE-7 `runOnce` already
 * swallows; this module wraps `start()` so a thrown registration error
 * cannot bubble into the bootstrap path either).
 *
 * Security invariants:
 *   - No env values appear in any log entry. `lifecycle.started` and
 *     `lifecycle.shutdown` emit only sanitised, allowlisted fields.
 *   - The shutdown grace window is bounded by `gracefulShutdownTimeoutMs`
 *     (default 30 s) so a hung in-flight job cannot block a deploy
 *     indefinitely.
 */
import type { CompositionRoot } from '../composition';
import { logger } from './logger';

// Default polling intervals — chosen to match STORAGE-FU-6 acceptance.
const DEFAULT_WORKER_POLL_INTERVAL_MS = 5_000;
const DEFAULT_CLEANUP_POLL_INTERVAL_MS = 60_000;
const DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 30_000;

// The signals we listen to. Documented here because the test suite
// uses the same constant to drive its simulated dispatches.
export const LIFECYCLE_SIGNALS = ['SIGTERM', 'SIGINT'] as const;
export type LifecycleSignal = (typeof LIFECYCLE_SIGNALS)[number];

export interface ResolvedLifecycleConfig {
  readonly workerPollIntervalMs: number;
  readonly cleanupPollIntervalMs: number;
  readonly gracefulShutdownTimeoutMs: number;
}

export interface StartLifecycleOptions {
  /**
   * Env reader. Defaults to `process.env`. Tests pass a minimal env so
   * they can probe the configuration surface without leaking real
   * values.
   */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Optional signal listener registration hook. Defaults to
   * `process.on`. Tests inject a fake to simulate `SIGTERM` / `SIGINT`
   * deterministically without sending real signals.
   */
  readonly registerSignalHandler?: (signal: LifecycleSignal, handler: () => void) => void;
  /**
   * Optional signal listener un-registration hook. Defaults to
   * `process.off`. Used when `stopLifecycle()` is called explicitly
   * (test path) so we leave no dangling listeners on the global
   * process.
   */
  readonly removeSignalHandler?: (signal: LifecycleSignal, handler: () => void) => void;
  /**
   * Optional process-exit hook. Defaults to `process.exit`. Tests inject
   * a spy so the test runner is not killed mid-suite.
   */
  readonly onShutdownComplete?: (code: number) => void;
  /**
   * Optional clock for shutdown-timeout enforcement. Defaults to
   * `Date.now`-based timeouts via `setTimeout`. Tests pass a stub timer
   * to drive the timeout deterministically.
   */
  readonly setTimeoutFn?: (handler: () => void, ms: number) => NodeJS.Timeout;
  readonly clearTimeoutFn?: (handle: NodeJS.Timeout) => void;
}

export interface LifecycleHandle {
  readonly config: ResolvedLifecycleConfig;
  /**
   * Stop both workers, await the in-flight shutdown, and remove the
   * signal handlers. Safe to call multiple times — second invocation
   * is a no-op.
   */
  readonly stop: () => Promise<void>;
}

// ── env parsing ───────────────────────────────────────────────────────────

// Strict integer pre-check used by both `parsePositiveIntMs` (here) and
// `parsePositiveInt` in `src/composition.ts`. We refuse anything that is
// not a pure base-10 integer literal so malformed envs like `"3.14"`,
// `"1e3"`, or `"5000ms"` cannot silently degrade poll intervals to
// truncated tiny numbers (Codex P1 review on PR #14).
const STRICT_INT_PATTERN = /^-?\d+$/;

/**
 * Parse a positive-integer milliseconds env value. Returns `fallback`
 * when the value is missing, blank, non-numeric, non-finite, negative,
 * or zero — never throws so the bootstrap path stays predictable on
 * misconfigured envs.
 *
 * Strict integer semantics:
 *   - rejects floats (`"3.14"` → fallback, NOT `3`)
 *   - rejects scientific notation (`"1e3"` → fallback, NOT `1`)
 *   - rejects trailing garbage (`"5000ms"` → fallback, NOT `5000`)
 *   - rejects unsafe integer overflow (`"99999999999999999999"` → fallback)
 *
 * These tighter rules close the gap flagged by Codex on PR #14 where
 * `Number.parseInt` silently truncated malformed envs.
 */
export function parsePositiveIntMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === null) return fallback;
  const trimmed = raw.trim();
  if (trimmed === '') return fallback;
  if (!STRICT_INT_PATTERN.test(trimmed)) return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function resolveLifecycleConfig(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedLifecycleConfig {
  return {
    workerPollIntervalMs: parsePositiveIntMs(
      env.STORAGE_WORKER_POLL_INTERVAL_MS,
      DEFAULT_WORKER_POLL_INTERVAL_MS,
    ),
    cleanupPollIntervalMs: parsePositiveIntMs(
      env.STORAGE_CLEANUP_INTERVAL_MS,
      DEFAULT_CLEANUP_POLL_INTERVAL_MS,
    ),
    gracefulShutdownTimeoutMs: parsePositiveIntMs(
      env.STORAGE_SHUTDOWN_TIMEOUT_MS,
      DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
    ),
  };
}

// ── start / stop ──────────────────────────────────────────────────────────

/**
 * Wire the composition's workers into the process lifecycle.
 *
 * Steps:
 *   1. Start `composition.worker` with the resolved worker interval.
 *   2. Start `composition.cleanup` with the resolved cleanup interval.
 *   3. Register `SIGTERM` / `SIGINT` handlers that drain + shutdown.
 *   4. Emit a `lifecycle.started` log entry with the resolved intervals
 *      ONLY (no env values, no provider config).
 *
 * The returned `stop()` method gives callers (mostly tests) an explicit
 * teardown surface that does NOT call `process.exit` — production paths
 * rely on the registered signal handlers.
 */
export function startLifecycle(
  composition: CompositionRoot,
  options: StartLifecycleOptions = {},
): LifecycleHandle {
  const env = options.env ?? process.env;
  const config = resolveLifecycleConfig(env);
  const register = options.registerSignalHandler ?? ((sig, fn) => process.on(sig, fn));
  const unregister = options.removeSignalHandler ?? ((sig, fn) => process.off(sig, fn));
  const onShutdownComplete = options.onShutdownComplete ?? ((code) => process.exit(code));
  const startTimeout =
    options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms) as unknown as NodeJS.Timeout);
  const stopTimeout =
    options.clearTimeoutFn ??
    ((handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>));

  // Track stop state so a second `SIGTERM` (or an explicit `stop()` call
  // racing the signal handler) collapses to one shutdown.
  let stopping: Promise<void> | null = null;
  const signalHandlers = new Map<LifecycleSignal, () => void>();

  // Defensive: if `worker.start` or `cleanup.start` were to throw (they
  // do not today, but a future refactor might), the service must still
  // boot. We wrap with try/catch and log — the worker exposes `runOnce`
  // anyway, so a missing polling loop degrades to "no background work"
  // rather than "service down".
  try {
    composition.worker.start(config.workerPollIntervalMs);
  } catch (err) {
    logger.error('storage.worker.start_failed', {
      event: 'storage.worker.start_failed',
      errorName: err instanceof Error ? err.name : 'unknown',
    });
  }

  try {
    composition.cleanup.start(config.cleanupPollIntervalMs);
  } catch (err) {
    logger.error('storage.cleanup.start_failed', {
      event: 'storage.cleanup.start_failed',
      errorName: err instanceof Error ? err.name : 'unknown',
    });
  }

  // Emit one structured `lifecycle.started` entry. Allowlisted fields
  // only: intervals + shutdown timeout. STORAGE-9 redaction is a
  // defence-in-depth — this entry is deliberately narrow.
  logger.info('storage.lifecycle.started', {
    event: 'storage.lifecycle.started',
    workerPollIntervalMs: config.workerPollIntervalMs,
    cleanupPollIntervalMs: config.cleanupPollIntervalMs,
    gracefulShutdownTimeoutMs: config.gracefulShutdownTimeoutMs,
  });

  const performShutdown = async (signal: LifecycleSignal | 'explicit'): Promise<void> => {
    if (stopping) return stopping;
    stopping = (async () => {
      logger.info('storage.lifecycle.shutdown', {
        event: 'storage.lifecycle.shutdown',
        signal,
      });

      // 1) Stop the polling loops so they do NOT schedule another
      //    drain. Any drain currently mid-flight finishes naturally.
      try {
        composition.worker.stop();
      } catch (err) {
        logger.error('storage.worker.stop_failed', {
          event: 'storage.worker.stop_failed',
          errorName: err instanceof Error ? err.name : 'unknown',
        });
      }
      try {
        composition.cleanup.stop();
      } catch (err) {
        logger.error('storage.cleanup.stop_failed', {
          event: 'storage.cleanup.stop_failed',
          errorName: err instanceof Error ? err.name : 'unknown',
        });
      }

      // 2) Tear down the composition (closes the owned DB pool). We
      //    race against the graceful-shutdown timeout so a hung
      //    Postgres close cannot block a deploy indefinitely.
      let timeoutHandle: NodeJS.Timeout | null = null;
      const timeout = new Promise<'timeout'>((resolve) => {
        timeoutHandle = startTimeout(() => resolve('timeout'), config.gracefulShutdownTimeoutMs);
      });
      try {
        const result = await Promise.race([
          composition.shutdown().then(() => 'shutdown' as const),
          timeout,
        ]);
        if (result === 'timeout') {
          logger.error('storage.lifecycle.shutdown_timeout', {
            event: 'storage.lifecycle.shutdown_timeout',
            gracefulShutdownTimeoutMs: config.gracefulShutdownTimeoutMs,
          });
        }
      } catch (err) {
        logger.error('storage.lifecycle.shutdown_failed', {
          event: 'storage.lifecycle.shutdown_failed',
          errorName: err instanceof Error ? err.name : 'unknown',
        });
      } finally {
        if (timeoutHandle) {
          stopTimeout(timeoutHandle);
        }
      }

      // 3) Remove any signal listeners we own so a second signal does
      //    not double-fire.
      for (const [sig, handler] of signalHandlers) {
        try {
          unregister(sig, handler);
        } catch {
          // Best-effort cleanup; never throw from shutdown.
        }
      }
      signalHandlers.clear();
    })();
    return stopping;
  };

  for (const signal of LIFECYCLE_SIGNALS) {
    const handler = (): void => {
      // `onShutdownComplete` defaults to `process.exit(0)`. Tests
      // inject a spy so the test runner survives the call.
      void performShutdown(signal).then(() => onShutdownComplete(0));
    };
    signalHandlers.set(signal, handler);
    try {
      register(signal, handler);
    } catch {
      // Some environments (e.g. workers without signal support) do not
      // allow signal registration. Degrade silently — the explicit
      // `stop()` path still works.
      signalHandlers.delete(signal);
    }
  }

  return {
    config,
    stop: async () => {
      await performShutdown('explicit');
    },
  };
}
