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
  ObjectKeyDerivationError,
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

describe('deriveProviderObjectKey — UUID guard (defense-in-depth)', () => {
  const validWorkspaceId = '00000000-0000-4000-8000-000000000001';
  const validObjectId = '00000000-0000-4000-8000-0000000000a1';

  function expectGuardThrows(
    input: { workspaceId: string; objectId: string; filename: string },
    field: 'workspaceId' | 'objectId',
  ) {
    try {
      deriveProviderObjectKey(input);
      throw new Error('expected ObjectKeyDerivationError');
    } catch (err) {
      expect(err).toBeInstanceOf(ObjectKeyDerivationError);
      expect((err as ObjectKeyDerivationError).code).toBe('INVALID_OBJECT_KEY_INPUT');
      expect((err as ObjectKeyDerivationError).statusHint).toBe(400);
      // Error message must NOT echo the offending value back (no oracle).
      // Empty-string inputs would trivially match `String.prototype.includes("")`
      // so we skip the no-echo assertion when the value is empty.
      const msg = (err as Error).message;
      if (input.workspaceId.length > 0) {
        expect(msg).not.toContain(input.workspaceId);
      }
      if (input.objectId.length > 0) {
        expect(msg).not.toContain(input.objectId);
      }
      // But it MUST identify which field was bad.
      expect(msg).toContain(field);
    }
  }

  test('rejects non-UUID workspaceId (path-traversal payload)', () => {
    expectGuardThrows(
      { workspaceId: '../../etc/passwd', objectId: validObjectId, filename: 'photo.jpg' },
      'workspaceId',
    );
  });

  test('rejects non-UUID workspaceId (slash injection)', () => {
    expectGuardThrows(
      { workspaceId: 'a/b', objectId: validObjectId, filename: 'photo.jpg' },
      'workspaceId',
    );
  });

  test('rejects non-UUID workspaceId (empty string)', () => {
    expectGuardThrows(
      { workspaceId: '', objectId: validObjectId, filename: 'photo.jpg' },
      'workspaceId',
    );
  });

  test('rejects non-UUID workspaceId (almost-UUID, missing dash)', () => {
    expectGuardThrows(
      {
        workspaceId: '000000000000-4000-8000-000000000001',
        objectId: validObjectId,
        filename: 'photo.jpg',
      },
      'workspaceId',
    );
  });

  test('rejects non-UUID objectId (path-traversal payload)', () => {
    expectGuardThrows(
      { workspaceId: validWorkspaceId, objectId: '../sneaky', filename: 'photo.jpg' },
      'objectId',
    );
  });

  test('rejects non-UUID objectId (NUL byte)', () => {
    expectGuardThrows(
      { workspaceId: validWorkspaceId, objectId: 'a\0b', filename: 'photo.jpg' },
      'objectId',
    );
  });

  test('rejects non-string workspaceId defensively', () => {
    // Type-cast intentional: simulating a caller that bypasses TS checks.
    const input = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      workspaceId: 42 as any,
      objectId: validObjectId,
      filename: 'photo.jpg',
    };
    expect(() => deriveProviderObjectKey(input)).toThrow(ObjectKeyDerivationError);
  });

  test('rejects non-string objectId defensively', () => {
    const input = {
      workspaceId: validWorkspaceId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      objectId: null as any,
      filename: 'photo.jpg',
    };
    expect(() => deriveProviderObjectKey(input)).toThrow(ObjectKeyDerivationError);
  });

  test('accepts uppercase-hex UUID (case-insensitive)', () => {
    const out = deriveProviderObjectKey({
      workspaceId: '00000000-0000-4000-8000-00000000ABCD',
      objectId: validObjectId,
      filename: 'photo.jpg',
    });
    expect(out).toContain('00000000-0000-4000-8000-00000000ABCD');
  });

  test('accepts UUID v1 / v5 shape (not pinned to v4)', () => {
    // RFC 4122 v1 example.
    const v1 = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
    const out = deriveProviderObjectKey({
      workspaceId: v1,
      objectId: validObjectId,
      filename: 'photo.jpg',
    });
    expect(out.startsWith(`workspaces/${v1}/objects/`)).toBe(true);
  });
});
