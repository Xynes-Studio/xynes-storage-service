/**
 * STORAGE-8 — variant-keys.ts unit tests.
 *
 * Defense-in-depth contract: variants MUST NEVER overwrite the
 * original `providerObjectKey`. The deriver places variants under
 * `<parent-dir>/variants/<role>.<ext>` and asserts non-collision.
 */
import { describe, expect, test } from 'bun:test';
import {
  assertVariantKeyDistinctFromOriginal,
  deriveVariantObjectKey,
  extensionForContentType,
} from '../../../../../src/actions/handlers/processing/runners/variant-keys';

describe('extensionForContentType', () => {
  test('maps the closed set of variant content types', () => {
    expect(extensionForContentType('image/avif')).toBe('avif');
    expect(extensionForContentType('image/webp')).toBe('webp');
    expect(extensionForContentType('image/jpeg')).toBe('jpg');
    expect(extensionForContentType('image/png')).toBe('png');
    expect(extensionForContentType('video/mp4')).toBe('mp4');
  });

  test('is case-insensitive', () => {
    expect(extensionForContentType('Image/AVIF')).toBe('avif');
  });

  test('falls back to "bin" for unknown content types', () => {
    expect(extensionForContentType('application/octet-stream')).toBe('bin');
    expect(extensionForContentType('garbage')).toBe('bin');
  });
});

describe('deriveVariantObjectKey', () => {
  test('places variants under <parent-dir>/variants/<role>.<ext>', () => {
    const key = deriveVariantObjectKey({
      parentObjectKey: 'workspaces/ws/objects/obj/photo.jpg',
      role: 'thumbnail_small',
      contentType: 'image/webp',
    });
    expect(key).toBe('workspaces/ws/objects/obj/variants/thumbnail_small.webp');
  });

  test('different roles yield distinct variant keys', () => {
    const a = deriveVariantObjectKey({
      parentObjectKey: 'workspaces/ws/objects/obj/photo.jpg',
      role: 'thumbnail_small',
      contentType: 'image/webp',
    });
    const b = deriveVariantObjectKey({
      parentObjectKey: 'workspaces/ws/objects/obj/photo.jpg',
      role: 'preview_medium',
      contentType: 'image/webp',
    });
    expect(a).not.toBe(b);
  });

  test('video poster vs transcode keys do not collide', () => {
    const poster = deriveVariantObjectKey({
      parentObjectKey: 'workspaces/ws/objects/obj/clip.mp4',
      role: 'poster',
      contentType: 'image/jpeg',
    });
    const transcode = deriveVariantObjectKey({
      parentObjectKey: 'workspaces/ws/objects/obj/clip.mp4',
      role: 'transcode_h264',
      contentType: 'video/mp4',
    });
    expect(poster).not.toBe(transcode);
    expect(poster.endsWith('/poster.jpg')).toBe(true);
    expect(transcode.endsWith('/transcode_h264.mp4')).toBe(true);
  });

  test('handles a parent key without any slash by emitting top-level variants/<role>.<ext>', () => {
    const key = deriveVariantObjectKey({
      parentObjectKey: 'rootonly.jpg',
      role: 'thumbnail_small',
      contentType: 'image/webp',
    });
    expect(key).toBe('variants/thumbnail_small.webp');
  });

  test('rejects empty parent keys', () => {
    expect(() =>
      deriveVariantObjectKey({
        parentObjectKey: '',
        role: 'thumbnail_small',
        contentType: 'image/webp',
      }),
    ).toThrow('parentObjectKey is required');
  });

  test('rejects non-string parent keys defensively', () => {
    expect(() =>
      deriveVariantObjectKey({
        parentObjectKey: undefined as unknown as string,
        role: 'thumbnail_small',
        contentType: 'image/webp',
      }),
    ).toThrow('parentObjectKey is required');
  });
});

describe('assertVariantKeyDistinctFromOriginal', () => {
  test('throws when variant key equals parent key (would overwrite the original)', () => {
    expect(() =>
      assertVariantKeyDistinctFromOriginal(
        'workspaces/ws/objects/obj/photo.jpg',
        'workspaces/ws/objects/obj/photo.jpg',
      ),
    ).toThrow(/variant key collides with parent key/);
  });

  test('passes when keys differ', () => {
    expect(() =>
      assertVariantKeyDistinctFromOriginal(
        'workspaces/ws/objects/obj/variants/thumbnail_small.webp',
        'workspaces/ws/objects/obj/photo.jpg',
      ),
    ).not.toThrow();
  });
});
