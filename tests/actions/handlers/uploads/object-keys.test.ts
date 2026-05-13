/**
 * STORAGE-5 — provider object-key derivation tests.
 *
 * Plan §STORAGE-9 invariants:
 *   - Keys include workspace + object boundaries.
 *   - Keys are unguessable enough to prevent enumeration (objectId is a UUID).
 *   - Sanitisation strips path separators and provider-reserved chars.
 *   - Total key length ≤ 1024 bytes (AWS S3 limit).
 */
import { describe, expect, test } from 'bun:test';
import {
  deriveProviderObjectKey,
  sanitiseFilenameSegment,
} from '../../../../src/actions/handlers/uploads/object-keys';

describe('sanitiseFilenameSegment', () => {
  test('passes safe filenames through (lower-cased)', () => {
    expect(sanitiseFilenameSegment('photo.jpg')).toBe('photo.jpg');
    expect(sanitiseFilenameSegment('My File.pdf')).toBe('my_file.pdf');
  });

  test('strips path separators', () => {
    expect(sanitiseFilenameSegment('../etc/passwd')).toBe('etc_passwd');
    expect(sanitiseFilenameSegment('subdir/file.jpg')).toBe('subdir_file.jpg');
    expect(sanitiseFilenameSegment('back\\slash.bin')).toBe('back_slash.bin');
  });

  test('strips ASCII control chars', () => {
    expect(sanitiseFilenameSegment('hi\u0000there.txt')).toBe('hi_there.txt');
    expect(sanitiseFilenameSegment('cr\rlf\n.txt')).toBe('cr_lf_.txt');
  });

  test('collapses non-safe runs to single underscore', () => {
    expect(sanitiseFilenameSegment('a@@@b.c')).toBe('a_b.c');
  });

  test('returns "file" for empty / hostile inputs', () => {
    expect(sanitiseFilenameSegment('')).toBe('file');
    expect(sanitiseFilenameSegment('   ')).toBe('file');
    expect(sanitiseFilenameSegment('.....')).toBe('file');
    expect(sanitiseFilenameSegment('_____')).toBe('file');
  });

  test('truncates very long filenames preserving extension when possible', () => {
    const longStem = 'x'.repeat(300);
    const out = sanitiseFilenameSegment(`${longStem}.jpg`);
    expect(out.endsWith('.jpg')).toBe(true);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(200);
  });

  test('non-string defensive guard', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(sanitiseFilenameSegment(undefined as any)).toBe('file');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(sanitiseFilenameSegment(42 as any)).toBe('file');
  });
});

describe('deriveProviderObjectKey', () => {
  test('builds workspaces/<ws>/objects/<obj>/<safe> layout', () => {
    const out = deriveProviderObjectKey({
      workspaceId: '00000000-0000-4000-8000-000000000001',
      objectId: '00000000-0000-4000-8000-0000000000a1',
      filename: 'photo.jpg',
    });
    expect(out).toBe(
      'workspaces/00000000-0000-4000-8000-000000000001/objects/00000000-0000-4000-8000-0000000000a1/photo.jpg',
    );
  });

  test('falls back to "file" when filename is hostile', () => {
    const out = deriveProviderObjectKey({
      workspaceId: '00000000-0000-4000-8000-000000000001',
      objectId: '00000000-0000-4000-8000-0000000000a1',
      filename: '',
    });
    expect(out.endsWith('/file')).toBe(true);
  });

  test('key is bounded to 1024 bytes (AWS S3 limit)', () => {
    const out = deriveProviderObjectKey({
      workspaceId: '00000000-0000-4000-8000-000000000001',
      objectId: '00000000-0000-4000-8000-0000000000a1',
      filename: 'a'.repeat(2000),
    });
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(1024);
  });
});
