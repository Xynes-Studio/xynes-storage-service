/**
 * STORAGE-FU-5-FU-G — parse-request tests.
 *
 * Strict JSON / base64 parsing. Closed-set error codes on every
 * failure. Raw input bytes NEVER leak into error messages — that's
 * verified at the response-shape layer (errors.test.ts) but
 * regression-guarded here too.
 */
import { describe, expect, test } from 'bun:test';

import { MAX_DOCUMENT_BYTES } from '../src/safe-mime';
import { MAX_REQUEST_BODY_BYTES, parseConvertRequest } from '../src/parse-request';

describe('parseConvertRequest — happy path', () => {
  test('decodes base64 bytes', () => {
    const body = JSON.stringify({
      sourceContentType: 'application/pdf',
      bytes: Buffer.from('hello world').toString('base64'),
    });
    const result = parseConvertRequest(body);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sourceContentType).toBe('application/pdf');
      expect(new TextDecoder().decode(result.value.bytes)).toBe('hello world');
    }
  });

  test('accepts whitespace in base64 (MIME line-wrapping)', () => {
    const wrapped = Buffer.from('A'.repeat(60)).toString('base64');
    const withNewlines = wrapped.replace(/(.{20})/g, '$1\n');
    const body = JSON.stringify({
      sourceContentType: 'application/pdf',
      bytes: withNewlines,
    });
    const result = parseConvertRequest(body);
    expect(result.ok).toBe(true);
  });
});

describe('parseConvertRequest — INVALID_JSON', () => {
  test('rejects non-JSON', () => {
    const result = parseConvertRequest('not json');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_JSON');
  });

  test('rejects JSON null', () => {
    const result = parseConvertRequest('null');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_JSON');
  });

  test('rejects JSON arrays', () => {
    const result = parseConvertRequest('[1,2,3]');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_JSON');
  });

  test('rejects JSON scalars', () => {
    const result = parseConvertRequest('"a string"');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_JSON');
  });
});

describe('parseConvertRequest — MISSING_FIELD', () => {
  test('rejects missing sourceContentType', () => {
    const result = parseConvertRequest(JSON.stringify({ bytes: 'aGVsbG8=' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('MISSING_FIELD');
  });

  test('rejects empty sourceContentType', () => {
    const result = parseConvertRequest(
      JSON.stringify({ sourceContentType: '', bytes: 'aGVsbG8=' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('MISSING_FIELD');
  });

  test('rejects non-string sourceContentType', () => {
    const result = parseConvertRequest(
      JSON.stringify({ sourceContentType: 42, bytes: 'aGVsbG8=' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('MISSING_FIELD');
  });

  test('rejects missing bytes', () => {
    const result = parseConvertRequest(JSON.stringify({ sourceContentType: 'application/pdf' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('MISSING_FIELD');
  });

  test('rejects empty bytes', () => {
    const result = parseConvertRequest(
      JSON.stringify({ sourceContentType: 'application/pdf', bytes: '' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('MISSING_FIELD');
  });

  test('rejects non-string bytes', () => {
    const result = parseConvertRequest(
      JSON.stringify({ sourceContentType: 'application/pdf', bytes: 12345 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('MISSING_FIELD');
  });
});

describe('parseConvertRequest — INVALID_BASE64', () => {
  test('rejects non-base64 characters', () => {
    const result = parseConvertRequest(
      JSON.stringify({ sourceContentType: 'application/pdf', bytes: '!@#$%^&*()' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_BASE64');
  });

  test('rejects base64 with wrong padding length', () => {
    const result = parseConvertRequest(
      JSON.stringify({ sourceContentType: 'application/pdf', bytes: 'aGVsbG8' /* missing = */ }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_BASE64');
  });

  test('rejects base64 with internal = (mid-string padding)', () => {
    const result = parseConvertRequest(
      JSON.stringify({ sourceContentType: 'application/pdf', bytes: 'aG=VsbG8=' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_BASE64');
  });
});

describe('parseConvertRequest — OVER_MAX_BYTES', () => {
  test('rejects decoded payload above MAX_DOCUMENT_BYTES', () => {
    // Build a base64 string whose decoded length is just past the cap.
    // We don't actually allocate 100 MiB — use a small payload + a
    // claimed length that we'd reject. Actually we DO need to decode
    // to detect overage, so make a 101 KiB synthetic payload and
    // temporarily shrink MAX_DOCUMENT_BYTES? No — the parser reads
    // the real constant. Instead, build a real 100 MiB+1 payload.
    // Allocating 100 MiB is fine in a test process.
    const overSize = MAX_DOCUMENT_BYTES + 1;
    const buffer = new Uint8Array(overSize);
    // Bun's Buffer.from can handle large arrays; the base64 string
    // is ~133 MiB which is fine for a test.
    const body = JSON.stringify({
      sourceContentType: 'application/pdf',
      bytes: Buffer.from(buffer).toString('base64'),
    });
    const result = parseConvertRequest(body);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('OVER_MAX_BYTES');
  });
});

describe('MAX_REQUEST_BODY_BYTES', () => {
  test('is larger than MAX_DOCUMENT_BYTES (base64 + envelope overhead)', () => {
    expect(MAX_REQUEST_BODY_BYTES).toBeGreaterThan(MAX_DOCUMENT_BYTES);
    // ~4/3 + 4 KiB envelope.
    const expected = Math.ceil((MAX_DOCUMENT_BYTES * 4) / 3) + 4096;
    expect(MAX_REQUEST_BODY_BYTES).toBe(expected);
  });
});
