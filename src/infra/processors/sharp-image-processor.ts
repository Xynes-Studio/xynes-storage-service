/**
 * STORAGE-FU-5-FU-A — sharp-backed `ImageProcessor`.
 *
 * Implements the STORAGE-8 `ImageProcessor` port using the
 * `sharp` (libvips) Node binding. Replaces `ProductionImageProcessorStub`
 * (which throws `UNSUPPORTED_FORMAT`) in `STORAGE_PROCESSOR_MODE=live`
 * deployments once the composition root wires this class in.
 *
 * ── Security invariants ──────────────────────────────────────────────────
 *
 *   1. **EXIF / GPS metadata stripping is MANDATORY.** Re-encode paths
 *      never call `.withMetadata()`, never pass `keep_*` flags, and
 *      never echo source metadata into the output container. Sharp's
 *      default posture is "strip on re-encode" — we rely on that AND
 *      assert it under test.
 *
 *   2. **Defense-in-depth hard cap re-validation.** STORAGE-8 image
 *      runners (`renderAndRecordVariant`) already pre-validate probe
 *      dimensions against `MAX_IMAGE_DIMENSION`. We re-validate INSIDE
 *      the processor too so a future direct caller (e.g. a probe
 *      followed by direct `renderVariant` from a different code path)
 *      can't bypass it.
 *
 *   3. **Sharp's global libvips pixel cache is disabled** via
 *      `sharp.cache(false)` at module load. The worker is not
 *      concurrently multi-tenant in MVP (STORAGE-7 maxConcurrent=4
 *      global, maxConcurrentPerWorkspace=2), but the libvips cache is
 *      process-wide and would accumulate cross-tenant pixel buffers
 *      between calls. Disabling the cache trades a small perf cost for
 *      a strong "no cross-tenant residue" guarantee.
 *
 *   4. **No filesystem temp files.** Sharp processes bytes in memory
 *      (`sharp(buffer)` → `.toBuffer()`). The processor never reaches
 *      for `os.tmpdir()` so a crash mid-encode cannot leak partial
 *      bytes to disk.
 *
 *   5. **Closed-set runner errors only.** Sharp / libvips error
 *      messages NEVER reach the caller. Library throws map to:
 *        - decode-time failure (probe / pre-render metadata) →
 *          `RunnerInputError('UNSUPPORTED_FORMAT')` (non-retryable
 *          per STORAGE-8 — retrying a malformed input won't help)
 *        - over-cap dimensions → `RunnerInputError('OVER_MAX_DIMENSIONS')`
 *        - render-time encode failure →
 *          `RunnerExecutionError('PROCESSOR_FAILED', retryable: true)`
 *          (the STORAGE-8 runner wraps these too, so this is
 *          belt-and-braces).
 *
 *   6. **No upscaling.** `.resize({ fit: 'inside', withoutEnlargement: true })`
 *      preserves the original dimensions when the variant cap is larger
 *      than the source. Avoids wasting bytes + matches the
 *      `FakeImageProcessor` posture used by the runner tests.
 *
 * ── Format mapping ───────────────────────────────────────────────────────
 *
 * STORAGE-8 `ImageVariantSpec.format` is a closed set of four values:
 *
 *   - `avif`      → AVIF (libavif via libvips, image/avif).
 *   - `webp`      → WebP (image/webp).
 *   - `jpeg`      → JPEG (image/jpeg).
 *   - `original`  → JPEG (image/jpeg) — STORAGE-8 contract requires the
 *                   wire `format` to be one of `avif|webp|jpeg|png`.
 *                   AVIF / WebP / JPEG / PNG are the only allowed
 *                   delivery formats; "original" means "fall back to
 *                   broadest-compatibility JPEG" rather than passing
 *                   through the source bytes.
 *
 * Note that PNG is a valid `ImageVariantRender.format` value but is
 * NOT a valid `ImageVariantSpec.format` value — variant specs in the
 * MVP only emit lossy formats. We keep the PNG branch in the
 * content-type lookup for future-proofing.
 */
import sharp from 'sharp';
import {
  RunnerExecutionError,
  RunnerInputError,
} from '../../actions/handlers/processing/runners/errors';
import type {
  ImageProbeResult,
  ImageProcessor,
  ImageVariantRender,
} from '../../actions/handlers/processing/runners/ports';
import {
  MAX_IMAGE_DIMENSION,
  type ImageVariantSpec,
} from '../../actions/handlers/processing/runners/profiles';

// Module-load side effect: disable libvips' process-wide pixel cache.
// See security invariant 3 above. This MUST happen exactly once at
// module load; sharp.cache() is global state.
sharp.cache(false);

const CONTENT_TYPE_BY_FORMAT: Readonly<Record<ImageVariantRender['format'], string>> =
  Object.freeze({
    avif: 'image/avif',
    webp: 'image/webp',
    jpeg: 'image/jpeg',
    png: 'image/png',
  });

/**
 * Resolve the wire `format` value from a STORAGE-8 `ImageVariantSpec.format`.
 * `original` falls back to JPEG per the STORAGE-8 acceptance criteria.
 */
function resolveOutputFormat(spec: ImageVariantSpec): ImageVariantRender['format'] {
  switch (spec.format) {
    case 'avif':
      return 'avif';
    case 'webp':
      return 'webp';
    case 'jpeg':
      return 'jpeg';
    case 'original':
      // STORAGE-8 fallback: broadest-compatibility JPEG re-encode.
      return 'jpeg';
  }
}

/**
 * Production image processor backed by sharp (libvips).
 *
 * Stateless — safe to instantiate once and share across the worker's
 * processing loop. The instance carries no per-call state; every
 * method is a pure transformation of bytes.
 */
export class SharpImageProcessor implements ImageProcessor {
  async probe(input: { bytes: Uint8Array }): Promise<ImageProbeResult> {
    let metadata: sharp.Metadata;
    try {
      metadata = await sharp(Buffer.from(input.bytes)).metadata();
    } catch {
      // libvips failed to decode → non-retryable input error. Any
      // raw message text is swallowed; the closed-set code is the
      // only signal that survives.
      throw new RunnerInputError('UNSUPPORTED_FORMAT');
    }
    if (
      typeof metadata.width !== 'number' ||
      typeof metadata.height !== 'number' ||
      metadata.width <= 0 ||
      metadata.height <= 0 ||
      typeof metadata.format !== 'string'
    ) {
      // Sharp returned metadata but the essentials are missing →
      // treat as malformed input.
      throw new RunnerInputError('UNSUPPORTED_FORMAT');
    }
    return {
      width: metadata.width,
      height: metadata.height,
      format: metadata.format,
      hasGpsExif: detectGpsExif(metadata),
    };
  }

  async renderVariant(input: {
    bytes: Uint8Array;
    spec: ImageVariantSpec;
  }): Promise<ImageVariantRender> {
    // Pre-decode metadata so we can re-validate the dimension cap
    // BEFORE the (potentially expensive) re-encode.
    let metadata: sharp.Metadata;
    try {
      metadata = await sharp(Buffer.from(input.bytes)).metadata();
    } catch {
      throw new RunnerInputError('UNSUPPORTED_FORMAT');
    }
    if (
      typeof metadata.width !== 'number' ||
      typeof metadata.height !== 'number' ||
      metadata.width <= 0 ||
      metadata.height <= 0
    ) {
      throw new RunnerInputError('UNSUPPORTED_FORMAT');
    }
    if (metadata.width > MAX_IMAGE_DIMENSION || metadata.height > MAX_IMAGE_DIMENSION) {
      throw new RunnerInputError('OVER_MAX_DIMENSIONS');
    }

    const outputFormat = resolveOutputFormat(input.spec);

    let outBuf: Buffer;
    let outInfo: sharp.OutputInfo;
    try {
      // Use a fresh sharp pipeline per call. `.rotate()` normalises
      // EXIF orientation BEFORE we strip metadata so a portrait photo
      // taken on a phone re-encodes to the right physical orientation.
      // `.resize({ fit: 'inside', withoutEnlargement: true })` honours
      // both max dimensions while preserving aspect ratio and never
      // upscaling a source smaller than the variant cap.
      const pipeline = sharp(Buffer.from(input.bytes)).rotate().resize({
        width: input.spec.maxWidth,
        height: input.spec.maxHeight,
        fit: 'inside',
        withoutEnlargement: true,
      });

      // Sharp's default posture is to strip metadata on re-encode. We
      // explicitly DO NOT call `.withMetadata()` — that would opt INTO
      // preservation. See security invariant 1.
      const encoded = await encodeForFormat(pipeline, outputFormat, input.spec.quality);
      outBuf = encoded.data;
      outInfo = encoded.info;
    } catch {
      // libvips failed at encode time. The runner-side wrapper would
      // ALSO map this to PROCESSOR_FAILED, but we surface it here
      // explicitly so direct callers (tests, future code paths) get
      // the same closed-set posture.
      throw new RunnerExecutionError('PROCESSOR_FAILED', { retryable: true });
    }

    return {
      // Copy into a fresh Uint8Array so the caller never observes the
      // underlying ArrayBuffer that sharp/libvips owned.
      bytes: new Uint8Array(outBuf),
      width: outInfo.width,
      height: outInfo.height,
      format: outputFormat,
      contentType: CONTENT_TYPE_BY_FORMAT[outputFormat],
    };
  }
}

/**
 * Detect whether the source metadata carries GPS EXIF tags. We look
 * for the standard GPS tag IDs (0x0001 GPSLatitudeRef, 0x0002
 * GPSLatitude, 0x0003 GPSLongitudeRef, 0x0004 GPSLongitude) inside the
 * raw EXIF buffer. Implementation note: sharp returns the EXIF segment
 * as an opaque `Buffer`. We don't fully decode it — we just probe for
 * the GPS tag IDs and the magic header `Exif\0\0`. A best-effort signal
 * is enough; the contract only promises a `hasGpsExif?: boolean`.
 */
function detectGpsExif(metadata: sharp.Metadata): boolean {
  if (!metadata.exif || metadata.exif.length === 0) return false;
  // Heuristic: the EXIF buffer usually contains "GPSInfo" or the
  // GPS tag bytes (0x88, 0x25 — IFD pointer to GPS sub-IFD: 0x8825).
  // The conservative check matches either substring.
  const buf = metadata.exif;
  // Look for the GPS IFD pointer tag 0x8825 in either byte order.
  for (let i = 0; i < buf.length - 1; i += 1) {
    if ((buf[i] === 0x88 && buf[i + 1] === 0x25) || (buf[i] === 0x25 && buf[i + 1] === 0x88)) {
      return true;
    }
  }
  return false;
}

/**
 * Encode the sharp pipeline with the right encoder for the requested
 * `format`. Quality is clamped to libvips' supported `[1, 100]` range
 * (the STORAGE-8 `ImageVariantSpec.quality` type allows 1..100 but a
 * malformed downstream caller could still pass an out-of-range value).
 */
async function encodeForFormat(
  pipeline: sharp.Sharp,
  format: ImageVariantRender['format'],
  rawQuality: number,
): Promise<{ data: Buffer; info: sharp.OutputInfo }> {
  const quality = Math.max(1, Math.min(100, Math.round(rawQuality)));
  switch (format) {
    case 'avif':
      return pipeline.avif({ quality }).toBuffer({ resolveWithObject: true });
    case 'webp':
      return pipeline.webp({ quality }).toBuffer({ resolveWithObject: true });
    case 'jpeg':
      return pipeline.jpeg({ quality }).toBuffer({ resolveWithObject: true });
    case 'png':
      // Lossless format — `quality` is ignored.
      return pipeline.png().toBuffer({ resolveWithObject: true });
  }
}
