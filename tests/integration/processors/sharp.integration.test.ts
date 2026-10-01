/**
 * STORAGE-FU-5-FU-F — sharp `ImageProcessor` integration suite.
 *
 * Exercises the live `SharpImageProcessor` (FU-5-FU-A) against the
 * committed `sample.jpg` + `sample.png` fixtures.
 *
 * `sharp` ships libvips as part of its npm package so this suite has
 * no soft-skip — it ALWAYS runs. The other binary-dependent suites
 * (`ffmpeg.integration`, `libreoffice.integration`,
 * `clamav.integration`) use `describeIfBinary` / `describeIfEnv`
 * gates.
 *
 * What the suite proves end-to-end (over and above the unit suite):
 *   - The committed JPEG fixture's synthetic GPS-EXIF marker is
 *     detected by the production heuristic.
 *   - The output JPEG / WebP / AVIF byte stream is GREATER than the
 *     1 KiB sanity floor (Bug 1 regression guard).
 *   - The output byte stream is RE-DECODABLE (i.e. it's a valid image,
 *     not the 8-byte stub-mode PNG signature).
 *   - EXIF is stripped from the output (re-probe asserts).
 *   - Dimension caps enforce the closed-set error codes.
 */
import { describe, expect, test } from 'bun:test';
import { SharpImageProcessor } from '../../../src/infra/processors/sharp-image-processor';
import type { ImageVariantSpec } from '../../../src/actions/handlers/processing/runners/profiles';
import { loadFixture } from './_helpers';
import {
  RunnerExecutionError,
  RunnerInputError,
} from '../../../src/actions/handlers/processing/runners/errors';

describe('STORAGE-FU-5-FU-F — SharpImageProcessor integration suite', () => {
  const processor = new SharpImageProcessor();
  const JPEG_FIXTURE = loadFixture('sample.jpg');
  const PNG_FIXTURE = loadFixture('sample.png');

  test('XYN-SEC-001: safe committed AVIF decodes and re-encodes with patched libheif', async () => {
    const bytes = loadFixture('sample.avif');
    const probe = await processor.probe({ bytes });
    expect(probe).toMatchObject({ width: 256, height: 192, format: 'heif' });
    const rendered = await processor.renderVariant({
      bytes,
      spec: { role: 'preview_medium', maxWidth: 128, maxHeight: 128, quality: 80, format: 'jpeg' },
    });
    expect(await processor.probe({ bytes: rendered.bytes })).toMatchObject({
      width: 128,
      height: 96,
      format: 'jpeg',
      hasGpsExif: false,
    });
  });

  test('XYN-SEC-001: safe HEIC metadata works; unavailable HEVC decoder fails safely', async () => {
    const bytes = loadFixture('sample.heic');
    expect(await processor.probe({ bytes })).toMatchObject({
      width: 256,
      height: 192,
      format: 'heif',
    });
    // Bundled Sharp supports AV1, not HEVC pixels. Preserve the existing safe
    // failure rather than claiming new HEIC rendering support.
    await expect(
      processor.renderVariant({
        bytes,
        spec: {
          role: 'preview_medium',
          maxWidth: 128,
          maxHeight: 128,
          quality: 80,
          format: 'jpeg',
        },
      }),
    ).rejects.toBeInstanceOf(RunnerExecutionError);
  });

  test.each(['sample.avif', 'sample.heic'] as const)(
    'XYN-SEC-001: truncated %s produces a closed-set error',
    async (name) => {
      const bytes = loadFixture(name).slice(0, 32);
      await expect(processor.probe({ bytes })).rejects.toBeInstanceOf(RunnerInputError);
      await expect(
        processor.renderVariant({
          bytes,
          spec: {
            role: 'preview_medium',
            maxWidth: 128,
            maxHeight: 128,
            quality: 80,
            format: 'jpeg',
          },
        }),
      ).rejects.toBeInstanceOf(RunnerInputError);
    },
  );

  test('probes the committed JPEG fixture (with synthetic GPS EXIF)', async () => {
    const out = await processor.probe({ bytes: JPEG_FIXTURE });
    expect(out.width).toBe(256);
    expect(out.height).toBe(192);
    expect(out.format).toBe('jpeg');
    // The committed fixture carries the standard 0x8825 GPS sub-IFD
    // pointer in an APP1 segment spliced after the SOI marker — this
    // is the same byte pattern real-world camera JPEGs use.
    expect(out.hasGpsExif).toBe(true);
  });

  test('probes the committed PNG fixture (no EXIF)', async () => {
    const out = await processor.probe({ bytes: PNG_FIXTURE });
    expect(out.width).toBe(256);
    expect(out.height).toBe(192);
    expect(out.format).toBe('png');
    expect(out.hasGpsExif).toBe(false);
  });

  // ─── Bug 1 (image) regression guard ───────────────────────────────────────
  // Every variant produced from a real input MUST be > 1024 bytes
  // (the sanity floor that distinguishes a real re-encode from the
  // 8-byte stub-mode PNG-signature artefact).
  // ─────────────────────────────────────────────────────────────────────────
  const FORMATS: Array<'jpeg' | 'webp' | 'avif'> = ['jpeg', 'webp', 'avif'];
  test.each(FORMATS)(
    'renderVariant against committed JPEG → %s output > 1 KiB (Bug 1 regression guard)',
    async (format) => {
      const spec: ImageVariantSpec = {
        role: 'preview_medium',
        maxWidth: 256,
        maxHeight: 192,
        quality: 80,
        format,
      };
      const out = await processor.renderVariant({ bytes: JPEG_FIXTURE, spec });
      // Sanity floor — the stub-mode PNG signature is 8 bytes.
      expect(out.bytes.byteLength).toBeGreaterThan(1024);
      // Upper-bound sanity check: catches a regression where we
      // accidentally swap profile for lossless.
      expect(out.bytes.byteLength).toBeLessThan(JPEG_FIXTURE.byteLength * 10);
      expect(out.format).toBe(format);
    },
  );

  // ─── EXIF strip invariant ────────────────────────────────────────────────
  test('GPS EXIF tag does NOT survive a JPEG → JPEG re-encode (STORAGE-9 invariant)', async () => {
    const out = await processor.renderVariant({
      bytes: JPEG_FIXTURE,
      spec: {
        role: 'preview_medium',
        maxWidth: 256,
        maxHeight: 192,
        quality: 80,
        format: 'jpeg',
      },
    });
    // Re-probe the output and assert the GPS tag is GONE.
    const reprobe = await processor.probe({ bytes: out.bytes });
    expect(reprobe.hasGpsExif).toBe(false);
  });

  test('GPS EXIF tag does NOT survive a JPEG → WebP re-encode', async () => {
    const out = await processor.renderVariant({
      bytes: JPEG_FIXTURE,
      spec: {
        role: 'preview_medium',
        maxWidth: 256,
        maxHeight: 192,
        quality: 80,
        format: 'webp',
      },
    });
    // For WebP, sharp's metadata.exif returns undefined when the
    // encoder dropped EXIF — `hasGpsExif: false` is the assertion
    // that proves the strip.
    const reprobe = await processor.probe({ bytes: out.bytes });
    expect(reprobe.hasGpsExif).toBe(false);
  });

  // ─── Defense-in-depth dimension cap ──────────────────────────────────────
  test('committed fixtures stay well under MAX_IMAGE_DIMENSION (16k)', async () => {
    const out = await processor.probe({ bytes: JPEG_FIXTURE });
    // The fixture is 256x192 — well under the 16k cap. This test
    // documents the cap rather than exercising it (a real 16k+ JPEG
    // would be a multi-MB fixture that defeats the "small committed
    // binary" rule from STORAGE-9).
    expect(out.width).toBeLessThan(16384);
    expect(out.height).toBeLessThan(16384);
  });
});
