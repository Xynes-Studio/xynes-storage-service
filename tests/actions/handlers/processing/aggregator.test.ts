/**
 * STORAGE-7 — aggregator tests.
 *
 * Asserts the pure mapping from job-list to aggregate object status.
 */
import { describe, test, expect } from 'bun:test';
import { computeAggregateStatus } from '../../../../src/actions/handlers/processing/aggregator';

const j = (
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled',
  required: boolean,
) => ({ status, required }) as const;

describe('computeAggregateStatus', () => {
  test('empty list -> null (no aggregate change)', () => {
    expect(computeAggregateStatus([])).toBeNull();
  });

  test('any required failed -> failed (even when other required ones are queued)', () => {
    expect(
      computeAggregateStatus([j('failed', true), j('queued', true), j('succeeded', true)]),
    ).toBe('failed');
  });

  test('any required queued/running -> processing', () => {
    expect(computeAggregateStatus([j('queued', true)])).toBe('processing');
    expect(computeAggregateStatus([j('running', true), j('succeeded', true)])).toBe('processing');
  });

  test('all required succeeded -> ready (non-required state ignored)', () => {
    expect(
      computeAggregateStatus([j('succeeded', true), j('queued', false), j('failed', false)]),
    ).toBe('ready');
  });

  test('non-required failed does NOT flip to failed', () => {
    expect(
      computeAggregateStatus([j('succeeded', true), j('failed', false), j('failed', false)]),
    ).toBe('ready');
  });

  test('non-required pending does NOT keep the object in processing once required ones finish', () => {
    expect(computeAggregateStatus([j('succeeded', true), j('queued', false)])).toBe('ready');
  });

  test('required cancelled is treated as a non-blocking terminal', () => {
    expect(computeAggregateStatus([j('cancelled', true), j('succeeded', true)])).toBe('ready');
  });

  test('soft-only list (no required jobs) never flips to failed', () => {
    expect(computeAggregateStatus([j('failed', false), j('failed', false)])).toBe('ready');
  });

  test('mixed list with one required queued + one required succeeded -> processing', () => {
    expect(computeAggregateStatus([j('queued', true), j('succeeded', true)])).toBe('processing');
  });

  test('single required succeeded -> ready', () => {
    expect(computeAggregateStatus([j('succeeded', true)])).toBe('ready');
  });

  test('single required failed -> failed', () => {
    expect(computeAggregateStatus([j('failed', true)])).toBe('failed');
  });
});
