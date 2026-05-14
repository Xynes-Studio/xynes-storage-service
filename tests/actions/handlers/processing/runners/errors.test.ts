/**
 * STORAGE-8 — errors.ts unit tests.
 */
import { describe, expect, test } from 'bun:test';
import {
  isRunnerError,
  RUNNER_ERROR_CODES,
  RunnerExecutionError,
  RunnerInputError,
} from '../../../../../src/actions/handlers/processing/runners/errors';

describe('RUNNER_ERROR_CODES', () => {
  test('exposes the closed-set of error codes', () => {
    expect(new Set(RUNNER_ERROR_CODES)).toEqual(
      new Set([
        'PROFILE_GUARD_REJECTED',
        'OVER_MAX_BYTES',
        'OVER_MAX_DIMENSIONS',
        'OVER_MAX_DURATION',
        'UNSUPPORTED_FORMAT',
        'MALWARE_DETECTED',
        'SCANNER_INCONCLUSIVE',
        'PROCESSOR_FAILED',
      ]),
    );
  });
});

describe('RunnerInputError', () => {
  test('is non-retryable', () => {
    const e = new RunnerInputError('OVER_MAX_BYTES');
    expect(e.retryable).toBe(false);
    expect(e.code).toBe('OVER_MAX_BYTES');
    expect(e.name).toBe('RunnerInputError');
    expect(e.message).toBe('OVER_MAX_BYTES');
  });
});

describe('RunnerExecutionError', () => {
  test('defaults to retryable', () => {
    const e = new RunnerExecutionError('PROCESSOR_FAILED');
    expect(e.retryable).toBe(true);
    expect(e.code).toBe('PROCESSOR_FAILED');
  });
  test('honors explicit retryable=false override', () => {
    const e = new RunnerExecutionError('PROCESSOR_FAILED', { retryable: false });
    expect(e.retryable).toBe(false);
  });
});

describe('isRunnerError', () => {
  test('returns true for both runner error classes', () => {
    expect(isRunnerError(new RunnerInputError('OVER_MAX_BYTES'))).toBe(true);
    expect(isRunnerError(new RunnerExecutionError('PROCESSOR_FAILED'))).toBe(true);
  });
  test('returns false for plain Error and unknown values', () => {
    expect(isRunnerError(new Error('boom'))).toBe(false);
    expect(isRunnerError('boom')).toBe(false);
    expect(isRunnerError(null)).toBe(false);
    expect(isRunnerError(undefined)).toBe(false);
    expect(isRunnerError({ code: 'OVER_MAX_BYTES' })).toBe(false);
  });
});
