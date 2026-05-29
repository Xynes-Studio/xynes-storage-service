/**
 * STORAGE-FU-5-FU-G — errors tests.
 *
 * Closed-set error codes + status + message contract. The static
 * validator asserts the wire shape; these tests assert the runtime
 * helpers stay redaction-safe.
 */
import { describe, expect, test } from 'bun:test';

import {
  SHIM_ERROR_CODES,
  SHIM_ERROR_MESSAGE,
  SHIM_ERROR_STATUS,
  buildErrorBody,
} from '../src/errors';

describe('SHIM_ERROR_CODES', () => {
  test('exports the documented closed-set codes', () => {
    expect(Object.keys(SHIM_ERROR_CODES).sort()).toEqual([
      'CONVERT_FAILED',
      'INTERNAL_ERROR',
      'INVALID_BASE64',
      'INVALID_JSON',
      'MISSING_FIELD',
      'OVER_MAX_BYTES',
      'TIMEOUT',
      'UNSUPPORTED_FORMAT',
    ]);
  });
});

describe('SHIM_ERROR_STATUS', () => {
  test('maps 4xx for caller errors and 5xx for sidecar errors', () => {
    expect(SHIM_ERROR_STATUS.INVALID_JSON).toBe(400);
    expect(SHIM_ERROR_STATUS.MISSING_FIELD).toBe(400);
    expect(SHIM_ERROR_STATUS.INVALID_BASE64).toBe(400);
    expect(SHIM_ERROR_STATUS.UNSUPPORTED_FORMAT).toBe(415);
    expect(SHIM_ERROR_STATUS.OVER_MAX_BYTES).toBe(413);
    expect(SHIM_ERROR_STATUS.CONVERT_FAILED).toBe(500);
    expect(SHIM_ERROR_STATUS.TIMEOUT).toBe(504);
    expect(SHIM_ERROR_STATUS.INTERNAL_ERROR).toBe(500);
  });
});

describe('SHIM_ERROR_MESSAGE', () => {
  test('messages are fixed strings (no interpolation)', () => {
    for (const code of Object.values(SHIM_ERROR_CODES)) {
      const msg = SHIM_ERROR_MESSAGE[code];
      expect(typeof msg).toBe('string');
      expect(msg.length).toBeGreaterThan(0);
      // STORAGE-9 invariant: error messages MUST NOT carry stderr blobs,
      // path leakage, or library version strings.
      expect(msg).not.toMatch(/soffice|libreoffice|\/tmp|\/var|stderr/i);
      expect(msg).not.toMatch(/xynes_live_|AKIA|X-Amz-Signature/);
    }
  });
});

describe('buildErrorBody', () => {
  test('returns the canonical envelope per code', () => {
    expect(buildErrorBody(SHIM_ERROR_CODES.INVALID_JSON)).toEqual({
      code: 'INVALID_JSON',
      message: SHIM_ERROR_MESSAGE.INVALID_JSON,
    });
    expect(buildErrorBody(SHIM_ERROR_CODES.OVER_MAX_BYTES)).toEqual({
      code: 'OVER_MAX_BYTES',
      message: SHIM_ERROR_MESSAGE.OVER_MAX_BYTES,
    });
  });
});
