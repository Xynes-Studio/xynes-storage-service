/**
 * STORAGE-7 — schema tests for the retry action payload.
 */
import { describe, test, expect } from 'bun:test';
import {
  retryProcessingPayloadSchema,
  processingActionPayloadSchema,
} from '../../../../src/actions/handlers/processing/schemas';

const validObjectId = '00000000-0000-4000-8000-100000000001';

describe('retryProcessingPayloadSchema', () => {
  test('accepts a valid {operation: "retry", objectId}', () => {
    const r = retryProcessingPayloadSchema.safeParse({
      operation: 'retry',
      objectId: validObjectId,
    });
    expect(r.success).toBe(true);
  });

  test('rejects unknown fields (strict)', () => {
    const r = retryProcessingPayloadSchema.safeParse({
      operation: 'retry',
      objectId: validObjectId,
      jobId: 'should-be-rejected',
    });
    expect(r.success).toBe(false);
  });

  test('rejects non-UUID objectId', () => {
    const r = retryProcessingPayloadSchema.safeParse({
      operation: 'retry',
      objectId: 'not-a-uuid',
    });
    expect(r.success).toBe(false);
  });

  test('rejects wrong operation', () => {
    const r = retryProcessingPayloadSchema.safeParse({
      operation: 'list',
      objectId: validObjectId,
    });
    expect(r.success).toBe(false);
  });

  test('rejects missing fields', () => {
    expect(retryProcessingPayloadSchema.safeParse({ operation: 'retry' }).success).toBe(false);
    expect(retryProcessingPayloadSchema.safeParse({ objectId: validObjectId }).success).toBe(false);
  });

  test('discriminated union accepts the retry shape', () => {
    const r = processingActionPayloadSchema.safeParse({
      operation: 'retry',
      objectId: validObjectId,
    });
    expect(r.success).toBe(true);
  });

  test('discriminated union rejects an unknown operation', () => {
    const r = processingActionPayloadSchema.safeParse({
      operation: 'cancel',
      objectId: validObjectId,
    });
    expect(r.success).toBe(false);
  });
});
