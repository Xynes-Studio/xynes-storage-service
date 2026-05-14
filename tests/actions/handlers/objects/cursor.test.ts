/**
 * STORAGE-6 — cursor codec tests.
 */
import { describe, expect, test } from 'bun:test';
import {
  InvalidCursorError,
  decodeListCursor,
  encodeListCursor,
} from '../../../../src/actions/handlers/objects/cursor';

const VALID_UUID = '00000000-0000-4000-8000-000000000001';
const VALID_ISO = '2026-05-13T12:00:00.000Z';

describe('cursor — encode/decode round-trip', () => {
  test('round-trips a valid cursor', () => {
    const enc = encodeListCursor({ lastCreatedAt: VALID_ISO, lastId: VALID_UUID });
    const dec = decodeListCursor(enc);
    expect(dec).toEqual({ lastCreatedAt: VALID_ISO, lastId: VALID_UUID });
  });

  test('returns null for null / undefined / empty', () => {
    expect(decodeListCursor(null)).toBeNull();
    expect(decodeListCursor(undefined)).toBeNull();
    expect(decodeListCursor('')).toBeNull();
  });

  test('rejects non-base64url garbage', () => {
    // Non-JSON after base64 decode.
    expect(() => decodeListCursor(Buffer.from('not-json', 'utf8').toString('base64url'))).toThrow(
      InvalidCursorError,
    );
  });

  test('rejects empty buffer cursor', () => {
    // Pure padding -> empty utf-8.
    expect(() => decodeListCursor('====')).toThrow(InvalidCursorError);
  });

  test('rejects truncated json', () => {
    const enc = Buffer.from('{"c":"', 'utf8').toString('base64url');
    expect(() => decodeListCursor(enc)).toThrow(InvalidCursorError);
  });

  test('rejects missing fields', () => {
    const enc = Buffer.from(JSON.stringify({ c: VALID_ISO }), 'utf8').toString('base64url');
    expect(() => decodeListCursor(enc)).toThrow(InvalidCursorError);
  });

  test('rejects non-ISO date', () => {
    const enc = Buffer.from(JSON.stringify({ c: 'yesterday', i: VALID_UUID }), 'utf8').toString(
      'base64url',
    );
    expect(() => decodeListCursor(enc)).toThrow(InvalidCursorError);
  });

  test('rejects non-UUID id', () => {
    const enc = Buffer.from(JSON.stringify({ c: VALID_ISO, i: 'not-a-uuid' }), 'utf8').toString(
      'base64url',
    );
    expect(() => decodeListCursor(enc)).toThrow(InvalidCursorError);
  });

  test('rejects non-string input type', () => {
    expect(() => decodeListCursor(42 as unknown as string)).toThrow(InvalidCursorError);
  });

  test('InvalidCursorError carries the documented code', () => {
    try {
      decodeListCursor('====');
    } catch (e) {
      expect((e as InvalidCursorError).code).toBe('INVALID_CURSOR');
      expect((e as InvalidCursorError).statusHint).toBe(400);
      // Message MUST NOT echo the cursor.
      expect((e as Error).message).toBe('Cursor is invalid');
    }
  });
});
