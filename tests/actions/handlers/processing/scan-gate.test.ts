import { describe, expect, test } from 'bun:test';
import { getScanValidationState } from '../../../../src/actions/handlers/processing/scan-gate';
import { makeJob, makeObject } from '../objects/_fakes';

const objectId = '00000000-0000-4000-8000-000000000010';
const object = makeObject({ id: objectId });
const scan = (status: Parameters<typeof makeJob>[0]['status']) =>
  makeJob({ objectId, jobType: 'scan_validation', required: true, status });

describe('XYN-SEC-001 scan-success evidence', () => {
  test('only successful required scans for this object pass', () => {
    expect(getScanValidationState(object, [scan('succeeded')])).toBe('passed');
    expect(
      getScanValidationState(object, [scan('succeeded'), makeJob({ objectId, status: 'failed' })]),
    ).toBe('passed');
  });
  test.each(['queued', 'running'] as const)('a %s scan is pending', (status) => {
    expect(getScanValidationState(object, [scan(status)])).toBe('pending');
  });
  test.each(['failed', 'cancelled'] as const)('a %s scan blocks', (status) => {
    expect(getScanValidationState(object, [scan(status)])).toBe('blocked');
  });
  test('missing, optional or foreign-object scans cannot authorize processing', () => {
    expect(getScanValidationState(object, [])).toBe('blocked');
    expect(getScanValidationState(object, [{ ...scan('succeeded'), required: false }])).toBe(
      'blocked',
    );
    expect(
      getScanValidationState(object, [{ ...scan('succeeded'), objectId: 'foreign-object' }]),
    ).toBe('blocked');
  });
  test('a successful scan does not override conflicting failed, pending or cancelled scans', () => {
    for (const status of ['failed', 'cancelled', 'queued', 'running'] as const) {
      expect(getScanValidationState(object, [scan('succeeded'), scan(status)])).not.toBe('passed');
    }
  });
});
