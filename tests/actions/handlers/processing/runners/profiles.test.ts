/**
 * STORAGE-8 — profiles.ts unit tests.
 */
import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_QUALITY_PROFILE,
  getImageProfile,
  getVideoProfile,
  IMAGE_VARIANT_ROLES,
  isQualityProfile,
  isSafeDocumentPreviewMime,
  MAX_DOCUMENT_BYTES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIMENSION,
  MAX_VIDEO_BYTES,
  MAX_VIDEO_DIMENSION,
  MAX_VIDEO_DURATION_SECONDS,
  QUALITY_PROFILES,
  SAFE_DOCUMENT_PREVIEW_MIMES,
  VIDEO_VARIANT_ROLES,
} from '../../../../../src/actions/handlers/processing/runners/profiles';

describe('quality profiles', () => {
  test('closed-set of three profiles', () => {
    expect(new Set(QUALITY_PROFILES)).toEqual(
      new Set(['balanced', 'high_quality', 'storage_saver']),
    );
  });

  test('default profile is balanced per plan STORAGE-8', () => {
    expect(DEFAULT_QUALITY_PROFILE).toBe('balanced');
  });

  test('isQualityProfile accepts only the closed set', () => {
    expect(isQualityProfile('balanced')).toBe(true);
    expect(isQualityProfile('high_quality')).toBe(true);
    expect(isQualityProfile('storage_saver')).toBe(true);
    expect(isQualityProfile('ultra')).toBe(false);
    expect(isQualityProfile('')).toBe(false);
    expect(isQualityProfile(null)).toBe(false);
    expect(isQualityProfile(undefined)).toBe(false);
    expect(isQualityProfile(42)).toBe(false);
  });
});

describe('getImageProfile', () => {
  test('balanced yields at least small / medium / web-optimized variants', () => {
    const p = getImageProfile('balanced');
    const roles = p.variants.map((v) => v.role);
    expect(roles).toContain('thumbnail_small');
    expect(roles).toContain('preview_medium');
    expect(roles).toContain('web_optimized');
  });

  test('high_quality includes an original_fallback variant', () => {
    const p = getImageProfile('high_quality');
    const roles = p.variants.map((v) => v.role);
    expect(roles).toContain('original_fallback');
  });

  test('storage_saver omits original_fallback (saves bytes)', () => {
    const p = getImageProfile('storage_saver');
    const roles = p.variants.map((v) => v.role);
    expect(roles).not.toContain('original_fallback');
  });

  test('every variant has sane quality in (0, 100]', () => {
    for (const profile of QUALITY_PROFILES) {
      for (const v of getImageProfile(profile).variants) {
        expect(v.quality).toBeGreaterThan(0);
        expect(v.quality).toBeLessThanOrEqual(100);
        expect(v.maxWidth).toBeGreaterThan(0);
        expect(v.maxHeight).toBeGreaterThan(0);
      }
    }
  });

  test('AVIF/WebP preference: web_optimized prefers AVIF, smaller variants prefer WebP', () => {
    const p = getImageProfile('balanced');
    const web = p.variants.find((v) => v.role === 'web_optimized');
    const thumb = p.variants.find((v) => v.role === 'thumbnail_small');
    expect(web?.format).toBe('avif');
    expect(thumb?.format).toBe('webp');
  });

  test('exposes the closed set of image variant roles', () => {
    expect(new Set(IMAGE_VARIANT_ROLES)).toEqual(
      new Set(['thumbnail_small', 'preview_medium', 'web_optimized', 'original_fallback']),
    );
  });
});

describe('getVideoProfile', () => {
  test('every video profile is H.264/AAC MP4 (MVP)', () => {
    for (const p of QUALITY_PROFILES) {
      const v = getVideoProfile(p);
      expect(v.codec).toBe('h264');
      expect(v.audioCodec).toBe('aac');
      expect(v.container).toBe('mp4');
    }
  });

  test('balanced caps playback at 720p', () => {
    const v = getVideoProfile('balanced');
    expect(v.maxHeight).toBeLessThanOrEqual(720);
  });

  test('high_quality allows up to 1080p', () => {
    const v = getVideoProfile('high_quality');
    expect(v.maxHeight).toBe(1080);
  });

  test('storage_saver caps at 480p / 1200 kbps for low bandwidth', () => {
    const v = getVideoProfile('storage_saver');
    expect(v.maxHeight).toBe(480);
    expect(v.targetBitrateKbps).toBeLessThanOrEqual(1500);
  });

  test('exposes the closed set of video variant roles', () => {
    expect(new Set(VIDEO_VARIANT_ROLES)).toEqual(new Set(['poster', 'transcode_h264']));
  });
});

describe('hard policy caps', () => {
  test('image cap is 50 MiB', () => {
    expect(MAX_IMAGE_BYTES).toBe(50 * 1024 * 1024);
  });
  test('video cap is 2 GiB', () => {
    expect(MAX_VIDEO_BYTES).toBe(2 * 1024 * 1024 * 1024);
  });
  test('document cap is 100 MiB', () => {
    expect(MAX_DOCUMENT_BYTES).toBe(100 * 1024 * 1024);
  });
  test('max image dimension is 16k', () => {
    expect(MAX_IMAGE_DIMENSION).toBe(16_384);
  });
  test('max video dimension is 4k', () => {
    expect(MAX_VIDEO_DIMENSION).toBe(4_096);
  });
  test('max video duration is one hour', () => {
    expect(MAX_VIDEO_DURATION_SECONDS).toBe(3600);
  });
});

describe('isSafeDocumentPreviewMime', () => {
  test('accepts every safe MIME on the allowlist', () => {
    for (const mime of SAFE_DOCUMENT_PREVIEW_MIMES) {
      expect(isSafeDocumentPreviewMime(mime)).toBe(true);
    }
  });

  test('is case-insensitive', () => {
    expect(isSafeDocumentPreviewMime('Application/PDF')).toBe(true);
  });

  test('rejects non-document MIMEs and unsafe document types', () => {
    expect(isSafeDocumentPreviewMime('application/zip')).toBe(false);
    expect(isSafeDocumentPreviewMime('image/jpeg')).toBe(false);
    expect(isSafeDocumentPreviewMime('text/html')).toBe(false);
    expect(isSafeDocumentPreviewMime('')).toBe(false);
  });

  test('defends against non-string inputs', () => {
    expect(isSafeDocumentPreviewMime(undefined as unknown as string)).toBe(false);
    expect(isSafeDocumentPreviewMime(null as unknown as string)).toBe(false);
    expect(isSafeDocumentPreviewMime(42 as unknown as string)).toBe(false);
  });
});

describe('SAFE_DOCUMENT_PREVIEW_MIMES', () => {
  test('exposes the allowlist as a Set with the expected members', () => {
    expect(SAFE_DOCUMENT_PREVIEW_MIMES.has('application/pdf')).toBe(true);
    expect(SAFE_DOCUMENT_PREVIEW_MIMES.has('application/zip')).toBe(false);
    // Closed list of nine MIMEs documented in plan STORAGE-8.
    expect(SAFE_DOCUMENT_PREVIEW_MIMES.size).toBe(9);
  });
});
