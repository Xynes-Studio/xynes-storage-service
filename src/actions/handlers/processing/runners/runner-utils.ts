/**
 * STORAGE-8 — shared error-mapping helper for runners.
 *
 * All STORAGE-8 runners return their result via this wrapper so the
 * worker sees a uniform `JobRunResult`:
 *   - Success returns `{}`.
 *   - `RunnerInputError`     -> `{ errorCode, retryable: false }`.
 *   - `RunnerExecutionError` -> `{ errorCode, retryable }`.
 *   - Any other thrown value is re-thrown so the worker can apply its
 *     own `RUNNER_THREW` policy. We do NOT translate unexpected throws
 *     to a runner errorCode here — the worker layer is the canonical
 *     redactor for non-runner exceptions.
 *
 * This wrapper is the single point where runners produce their
 * `JobRunResult` payload, so the closed-set of error codes is enforced
 * by construction.
 */
import type { JobRunResult } from '../types';
import { isRunnerError } from './errors';

export async function runRunnerWithErrorMapping(
  fn: () => Promise<JobRunResult | void>,
): Promise<JobRunResult | void> {
  try {
    return await fn();
  } catch (err) {
    if (isRunnerError(err)) {
      return { errorCode: err.code, retryable: err.retryable };
    }
    throw err;
  }
}
