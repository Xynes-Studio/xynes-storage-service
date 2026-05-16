/**
 * STORAGE-FU-5 — stub-mode processors for local dev + integration smoke.
 *
 * These implementations satisfy the STORAGE-8 processor port contracts
 * without invoking sharp / ffmpeg / libreoffice. They are not
 * production-grade: image / video / document outputs are pass-through
 * stubs with a small synthetic byte payload + deterministic dimensions.
 *
 * Default mode for `NODE_ENV !== 'production'`. Production deployments
 * MUST select the live mode via `STORAGE_PROCESSOR_MODE=live` AND wire
 * production processors (currently `production-*-processor.ts` stubs
 * that throw `UNSUPPORTED_FORMAT` until the follow-up infra story
 * lands the real sharp / ffmpeg / libreoffice adapters).
 *
 * SECURITY invariants:
 *   - The stubs NEVER decode or re-encode bytes. They cannot leak
 *     library-emitted metadata because they don't invoke a library.
 *   - Synthetic outputs are tiny (< 64 bytes) so the test posture
 *     stays fast.
 *   - The stubs deliberately use FIXED dimensions so the upstream
 *     hard-cap guards (`MAX_IMAGE_DIMENSION` / `MAX_VIDEO_DIMENSION` /
 *     `MAX_VIDEO_DURATION_SECONDS`) are never tripped — the stubs are
 *     for end-to-end wiring smoke, not for media-correctness tests.
 */
import type {
  DocumentPreviewRender,
  DocumentProcessor,
  ImageProbeResult,
  ImageProcessor,
  ImageVariantRender,
  VideoPosterRender,
  VideoProbeResult,
  VideoProcessor,
  VideoTranscodeRender,
} from '../../actions/handlers/processing/runners/ports';
import type {
  ImageVariantSpec,
  VideoProfile,
} from '../../actions/handlers/processing/runners/profiles';

// ── Stub image processor ──────────────────────────────────────────────────

// `Object.freeze` on a typed array attempts to make element 0 non-
// configurable, which V8 rejects. We use a readonly template constant
// (NOT frozen) and clone-on-read so callers can't mutate the shared
// buffer — each `renderVariant` call returns `new Uint8Array(template)`.
const STUB_IMAGE_BYTES: Uint8Array = new Uint8Array([
  // 8-byte PNG signature so a downstream consumer that sniffs the
  // header doesn't choke. Body is intentionally empty.
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export class StubImageProcessor implements ImageProcessor {
  async probe(_input: { bytes: Uint8Array }): Promise<ImageProbeResult> {
    void _input;
    return {
      width: 1024,
      height: 768,
      format: 'jpeg',
      hasGpsExif: false,
    };
  }

  async renderVariant(input: {
    bytes: Uint8Array;
    spec: ImageVariantSpec;
  }): Promise<ImageVariantRender> {
    const { spec } = input;
    const targetFormat: ImageVariantRender['format'] =
      spec.format === 'original' ? 'jpeg' : spec.format;
    const contentTypeByFormat: Record<ImageVariantRender['format'], string> = {
      avif: 'image/avif',
      webp: 'image/webp',
      jpeg: 'image/jpeg',
      png: 'image/png',
    };
    return {
      bytes: new Uint8Array(STUB_IMAGE_BYTES),
      width: Math.min(spec.maxWidth, 1024),
      height: Math.min(spec.maxHeight, 768),
      format: targetFormat,
      contentType: contentTypeByFormat[targetFormat],
    };
  }
}

// ── Stub video processor ──────────────────────────────────────────────────

const STUB_VIDEO_BYTES: Uint8Array = new Uint8Array([
  // 'ftypisom' MP4 box header so a sniffer can identify it.
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x00, 0x01,
  0x69, 0x73, 0x6f, 0x6d, 0x61, 0x76, 0x63, 0x31,
]);

const STUB_POSTER_BYTES: Uint8Array = new Uint8Array([
  // 4-byte JPEG SOI + EOI markers.
  0xff, 0xd8, 0xff, 0xd9,
]);

export class StubVideoProcessor implements VideoProcessor {
  async probe(_input: { bytes: Uint8Array }): Promise<VideoProbeResult> {
    void _input;
    return {
      durationSeconds: 12,
      width: 1280,
      height: 720,
      container: 'mp4',
      videoCodec: 'h264',
      audioCodec: 'aac',
      rotationDegrees: 0,
    };
  }

  async renderPoster(input: {
    bytes: Uint8Array;
    profile: VideoProfile;
  }): Promise<VideoPosterRender> {
    const { profile } = input;
    return {
      bytes: new Uint8Array(STUB_POSTER_BYTES),
      width: Math.min(profile.posterMaxWidth, 1280),
      height: Math.min(profile.posterMaxHeight, 720),
      contentType: 'image/jpeg',
    };
  }

  async renderTranscode(input: {
    bytes: Uint8Array;
    profile: VideoProfile;
  }): Promise<VideoTranscodeRender> {
    const { profile } = input;
    return {
      bytes: new Uint8Array(STUB_VIDEO_BYTES),
      width: Math.min(profile.maxWidth, 1280),
      height: Math.min(profile.maxHeight, 720),
      durationSeconds: 12,
      contentType: 'video/mp4',
    };
  }
}

// ── Stub document processor ────────────────────────────────────────────────

const STUB_DOCUMENT_PREVIEW_BYTES: Uint8Array = new Uint8Array([
  // 4-byte JPEG SOI + EOI markers.
  0xff, 0xd8, 0xff, 0xd9,
]);

export class StubDocumentProcessor implements DocumentProcessor {
  async renderFirstPagePreview(_input: {
    bytes: Uint8Array;
    sourceContentType: string;
  }): Promise<DocumentPreviewRender> {
    void _input;
    return {
      bytes: new Uint8Array(STUB_DOCUMENT_PREVIEW_BYTES),
      contentType: 'image/jpeg',
      width: 800,
      height: 1100,
    };
  }
}
