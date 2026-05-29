/**
 * STORAGE-FU-5-FU-G — safe-mime tests.
 *
 * Asserts the closed-set MIME allowlist mirrors FU-C byte-for-byte
 * and that `resolveSafeMime` rejects every off-list value.
 */
import { describe, expect, test } from 'bun:test';

import { MAX_DOCUMENT_BYTES, SAFE_DOCUMENT_PREVIEW_MIMES, resolveSafeMime } from '../src/safe-mime';

describe('SAFE_DOCUMENT_PREVIEW_MIMES', () => {
  test('mirrors the FU-C allowlist set (9 entries)', () => {
    const mimes = SAFE_DOCUMENT_PREVIEW_MIMES.map((entry) => entry.mime);
    // Byte-for-byte parity with `SAFE_DOCUMENT_PREVIEW_MIMES` in
    // xynes-storage-service/src/actions/handlers/processing/runners/profiles.ts.
    expect(mimes).toEqual([
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.oasis.opendocument.text',
      'application/vnd.oasis.opendocument.spreadsheet',
      'application/vnd.oasis.opendocument.presentation',
      'application/rtf',
    ]);
  });

  test('every entry has a closed-set extension + convertProfile', () => {
    const allowedExts = new Set(['pdf', 'doc', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'rtf']);
    for (const entry of SAFE_DOCUMENT_PREVIEW_MIMES) {
      expect(allowedExts.has(entry.inputExtension)).toBe(true);
      expect(entry.convertProfile).toBe('png');
    }
  });

  test('MAX_DOCUMENT_BYTES matches FU-C value (100 MiB)', () => {
    expect(MAX_DOCUMENT_BYTES).toBe(100 * 1024 * 1024);
  });
});

describe('resolveSafeMime', () => {
  test('resolves canonical MIME strings', () => {
    expect(resolveSafeMime('application/pdf')?.inputExtension).toBe('pdf');
    expect(resolveSafeMime('application/msword')?.inputExtension).toBe('doc');
  });

  test('lowercases before matching', () => {
    expect(resolveSafeMime('APPLICATION/PDF')?.inputExtension).toBe('pdf');
    expect(resolveSafeMime('Application/Vnd.Oasis.OpenDocument.Text')?.inputExtension).toBe('odt');
  });

  test('strips charset parameters', () => {
    expect(resolveSafeMime('application/pdf; charset=utf-8')?.inputExtension).toBe('pdf');
    expect(resolveSafeMime('application/rtf;profile=ascii')?.inputExtension).toBe('rtf');
  });

  test('returns null for unknown MIMEs', () => {
    expect(resolveSafeMime('image/png')).toBeNull();
    expect(resolveSafeMime('application/json')).toBeNull();
    expect(resolveSafeMime('text/html')).toBeNull();
    expect(resolveSafeMime('application/javascript')).toBeNull();
    expect(resolveSafeMime('application/x-php')).toBeNull();
  });

  test('returns null for empty / whitespace / null / non-string', () => {
    expect(resolveSafeMime('')).toBeNull();
    expect(resolveSafeMime('   ')).toBeNull();
    expect(resolveSafeMime(null)).toBeNull();
    expect(resolveSafeMime(undefined)).toBeNull();
    expect(resolveSafeMime(42 as unknown as string)).toBeNull();
    expect(resolveSafeMime({} as unknown as string)).toBeNull();
  });
});
