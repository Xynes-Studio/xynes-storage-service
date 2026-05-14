/**
 * STORAGE-8 — named quality profiles + hard policy caps.
 *
 * These constants are PURE data — they encode the product decisions
 * documented in `2026-05-10-universal-object-storage-file-upload-api.md`
 * STORAGE-8 acceptance criteria:
 *
 *   - Named quality profiles: `balanced` (MVP default), `high_quality`,
 *     `storage_saver`.
 *   - Objective guardrails: max dimensions, target byte ranges, codec
 *     settings.
 *   - Generate at least: small thumbnail, medium preview, web-optimized
 *     variant, optional original-format fallback.
 *   - Prefer AVIF/WebP where supported, JPEG fallback for compatibility.
 *   - Never overwrite the original object.
 *
 * Profiles are deliberately closed-set. New profiles require a code
 * change so SLO targets stay reviewable.
 *
 * SECURITY / SAFETY:
 *   - Hard caps (`MAX_*`) are *independent* of profile choice — a
 *     hostile or misconfigured profile cannot raise them.
 *   - No filesystem path, signed URL, provider config, or credential
 *     reference appears in this module.
 */

// ── Quality profiles ───────────────────────────────────────────────────────

export const QUALITY_PROFILES = ['balanced', 'high_quality', 'storage_saver'] as const;
export type QualityProfile = (typeof QUALITY_PROFILES)[number];
export const DEFAULT_QUALITY_PROFILE: QualityProfile = 'balanced';

export function isQualityProfile(value: unknown): value is QualityProfile {
  return typeof value === 'string' && (QUALITY_PROFILES as readonly string[]).includes(value);
}

// ── Variant role identifiers (closed set) ──────────────────────────────────

export const IMAGE_VARIANT_ROLES = [
  'thumbnail_small',
  'preview_medium',
  'web_optimized',
  'original_fallback',
] as const;
export type ImageVariantRole = (typeof IMAGE_VARIANT_ROLES)[number];

export const VIDEO_VARIANT_ROLES = ['poster', 'transcode_h264'] as const;
export type VideoVariantRole = (typeof VIDEO_VARIANT_ROLES)[number];

export const DOCUMENT_VARIANT_ROLES = ['preview_first_page'] as const;
export type DocumentVariantRole = (typeof DOCUMENT_VARIANT_ROLES)[number];

export type VariantRole = ImageVariantRole | VideoVariantRole | DocumentVariantRole;

// ── Image profile spec ────────────────────────────────────────────────────

export interface ImageVariantSpec {
  readonly role: ImageVariantRole;
  readonly maxWidth: number;
  readonly maxHeight: number;
  /** 1..100, libvips-style quality. */
  readonly quality: number;
  /** Preferred output format. JPEG is the always-supported fallback. */
  readonly format: 'avif' | 'webp' | 'jpeg' | 'original';
}

export interface ImageProfile {
  readonly profile: QualityProfile;
  readonly variants: ReadonlyArray<ImageVariantSpec>;
}

const IMAGE_PROFILES: Readonly<Record<QualityProfile, ImageProfile>> = Object.freeze({
  balanced: {
    profile: 'balanced',
    variants: [
      { role: 'thumbnail_small', maxWidth: 320, maxHeight: 320, quality: 75, format: 'webp' },
      { role: 'preview_medium', maxWidth: 1024, maxHeight: 1024, quality: 78, format: 'webp' },
      { role: 'web_optimized', maxWidth: 2048, maxHeight: 2048, quality: 80, format: 'avif' },
    ],
  },
  high_quality: {
    profile: 'high_quality',
    variants: [
      { role: 'thumbnail_small', maxWidth: 320, maxHeight: 320, quality: 80, format: 'webp' },
      { role: 'preview_medium', maxWidth: 1600, maxHeight: 1600, quality: 85, format: 'webp' },
      { role: 'web_optimized', maxWidth: 4096, maxHeight: 4096, quality: 88, format: 'avif' },
      {
        role: 'original_fallback',
        maxWidth: 8192,
        maxHeight: 8192,
        quality: 90,
        format: 'original',
      },
    ],
  },
  storage_saver: {
    profile: 'storage_saver',
    variants: [
      { role: 'thumbnail_small', maxWidth: 240, maxHeight: 240, quality: 65, format: 'webp' },
      { role: 'preview_medium', maxWidth: 800, maxHeight: 800, quality: 68, format: 'webp' },
      { role: 'web_optimized', maxWidth: 1600, maxHeight: 1600, quality: 70, format: 'avif' },
    ],
  },
});

export function getImageProfile(profile: QualityProfile): ImageProfile {
  return IMAGE_PROFILES[profile];
}

// ── Video profile spec ────────────────────────────────────────────────────

export interface VideoProfile {
  readonly profile: QualityProfile;
  /** Codec for the normalized playback file. MP4/H.264 only in MVP. */
  readonly codec: 'h264';
  readonly audioCodec: 'aac';
  readonly container: 'mp4';
  readonly maxWidth: number;
  readonly maxHeight: number;
  /** Target average bitrate (kbps). */
  readonly targetBitrateKbps: number;
  /** Poster thumbnail dimensions. */
  readonly posterMaxWidth: number;
  readonly posterMaxHeight: number;
}

const VIDEO_PROFILES: Readonly<Record<QualityProfile, VideoProfile>> = Object.freeze({
  balanced: {
    profile: 'balanced',
    codec: 'h264',
    audioCodec: 'aac',
    container: 'mp4',
    maxWidth: 1280,
    maxHeight: 720,
    targetBitrateKbps: 2500,
    posterMaxWidth: 640,
    posterMaxHeight: 360,
  },
  high_quality: {
    profile: 'high_quality',
    codec: 'h264',
    audioCodec: 'aac',
    container: 'mp4',
    maxWidth: 1920,
    maxHeight: 1080,
    targetBitrateKbps: 5000,
    posterMaxWidth: 1280,
    posterMaxHeight: 720,
  },
  storage_saver: {
    profile: 'storage_saver',
    codec: 'h264',
    audioCodec: 'aac',
    container: 'mp4',
    maxWidth: 854,
    maxHeight: 480,
    targetBitrateKbps: 1200,
    posterMaxWidth: 480,
    posterMaxHeight: 270,
  },
});

export function getVideoProfile(profile: QualityProfile): VideoProfile {
  return VIDEO_PROFILES[profile];
}

// ── Hard policy caps (independent of profile) ─────────────────────────────

/**
 * Hard byte-size caps per family. These are the upper bounds the worker
 * applies *before* invoking the processor — a profile cannot raise these.
 * Aligns with the platform-wide MVP defaults documented in
 * `2026-05-10-universal-object-storage-file-upload-api.md` §10.
 */
export const MAX_IMAGE_BYTES = 50 * 1024 * 1024; // 50 MiB
export const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
export const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024; // 100 MiB

/** Hard pixel dimension cap. Anything larger fails before processor work. */
export const MAX_IMAGE_DIMENSION = 16_384;
export const MAX_VIDEO_DIMENSION = 4_096;

/** Hard duration cap for video (seconds). */
export const MAX_VIDEO_DURATION_SECONDS = 60 * 60; // 1 hour

/** Document preview safe-MIME allowlist (subset of objects/schemas safe-document set). */
export const SAFE_DOCUMENT_PREVIEW_MIMES = Object.freeze(
  new Set([
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.oasis.opendocument.text',
    'application/vnd.oasis.opendocument.spreadsheet',
    'application/vnd.oasis.opendocument.presentation',
    'application/rtf',
  ]),
);

/** Returns true iff a content type is on the safe document preview allowlist. */
export function isSafeDocumentPreviewMime(contentType: string): boolean {
  if (typeof contentType !== 'string') return false;
  return SAFE_DOCUMENT_PREVIEW_MIMES.has(contentType.toLowerCase());
}
