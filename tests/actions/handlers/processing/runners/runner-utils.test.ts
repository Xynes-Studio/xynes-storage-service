/**
 * STORAGE-8 — runner-utils unit tests.
 *
 * Verifies `runRunnerWithErrorMapping` translates RunnerInputError /
 * RunnerExecutionError into `JobRunResult` payloads the worker
 * understands, and re-throws unexpected errors so the worker's
 * `RUNNER_THREW` redaction layer kicks in.
 */
import { describe, expect, test } from 'bun:test';
import {
  RunnerExecutionError,
  RunnerInputError,
} from '../../../../../src/actions/handlers/processing/runners/errors';
import { runRunnerWithErrorMapping } from '../../../../../src/actions/handlers/processing/runners/runner-utils';

describe('runRunnerWithErrorMapping', () => {
  test('returns the inner function result unchanged on success', async () => {
    const out = await runRunnerWithErrorMapping(async () => ({}));
    expect(out).toEqual({});
  });

  test('returns void unchanged on success', async () => {
    const out = await runRunnerWithErrorMapping(async () => {
      /* void */
    });
    expect(out).toBeUndefined();
  });

  test('translates RunnerInputError to non-retryable errorCode result', async () => {
    const out = await runRunnerWithErrorMapping(async () => {
      throw new RunnerInputError('OVER_MAX_BYTES');
    });
    expect(out).toEqual({ errorCode: 'OVER_MAX_BYTES', retryable: false });
  });

  test('translates RunnerExecutionError to retryable errorCode result by default', async () => {
    const out = await runRunnerWithErrorMapping(async () => {
      throw new RunnerExecutionError('PROCESSOR_FAILED');
    });
    expect(out).toEqual({ errorCode: 'PROCESSOR_FAILED', retryable: true });
  });

  test('preserves explicit retryable=false on RunnerExecutionError', async () => {
    const out = await runRunnerWithErrorMapping(async () => {
      throw new RunnerExecutionError('PROCESSOR_FAILED', { retryable: false });
    });
    expect(out).toEqual({ errorCode: 'PROCESSOR_FAILED', retryable: false });
  });

  test('re-throws plain Errors so worker logs them as RUNNER_THREW', async () => {
    await expect(
      runRunnerWithErrorMapping(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  test('re-throws non-Error throws unchanged', async () => {
    await expect(
      runRunnerWithErrorMapping(async () => {
        throw 'string-not-error';
      }),
    ).rejects.toBe('string-not-error');
  });
});
