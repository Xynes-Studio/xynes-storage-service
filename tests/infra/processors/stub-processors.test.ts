/**
 * STORAGE-FU-5 — stub-mode processors tests.
 *
 * The stubs satisfy the STORAGE-8 processor port contracts without
 * invoking sharp / ffmpeg / libreoffice. Tests verify the contract
 * adherence + deterministic output shape so local-dev smoke remains
 * predictable.
 *
 * Note: the stubs are intentionally NOT verified for media correctness
 * — they emit short synthetic byte payloads. Production processors
 * land via the follow-up infra story.
 */
import { describe, expect, test } from 'bun:test';
import {
  StubImageProcessor,
  StubVideoProcessor,
  StubDocumentProcessor,
} from '../../../src/infra/processors/stub-processors';
import {
  getImageProfile,
  getVideoProfile,
} from '../../../src/actions/handlers/processing/runners/profiles';

describe('StubImageProcessor', () => {
  test('probe returns fixed dimensions below the hard cap', async () => {
    const p = new StubImageProcessor();
    const r = await p.probe({ bytes: new Uint8Array() });
    expect(r.width).toBe(1024);
    expect(r.height).toBe(768);
    expect(r.format).toBe('jpeg');
    expect(r.hasGpsExif).toBe(false);
  });

  test('renderVariant for balanced profile produces non-empty bytes + correct content-type', async () => {
    const p = new StubImageProcessor();
    const profile = getImageProfile('balanced');
    for (const spec of profile.variants) {
      const r = await p.renderVariant({ bytes: new Uint8Array([0x99]), spec });
      expect(r.bytes.byteLength).toBeGreaterThan(0);
      expect(r.width).toBeLessThanOrEqual(spec.maxWidth);
      expect(r.height).toBeLessThanOrEqual(spec.maxHeight);
      // The "original" format spec should downgrade to JPEG in stub mode.
      if (spec.format === 'original') {
        expect(r.format).toBe('jpeg');
      } else {
        expect(r.format).toBe(spec.format);
      }
    }
  });

  test('renderVariant returns a CLONED byte buffer (no shared mutation)', async () => {
    const p = new StubImageProcessor();
    const profile = getImageProfile('balanced');
    const a = await p.renderVariant({ bytes: new Uint8Array(), spec: profile.variants[0]! });
    const b = await p.renderVariant({ bytes: new Uint8Array(), spec: profile.variants[0]! });
    a.bytes[0] = 0; // mutate copy a
    expect(b.bytes[0]).not.toBe(0); // b is independent
  });
});

describe('StubVideoProcessor', () => {
  test('probe returns dimensions + duration below the hard caps', async () => {
    const p = new StubVideoProcessor();
    const r = await p.probe({ bytes: new Uint8Array() });
    expect(r.durationSeconds).toBeLessThan(60 * 60); // under 1h cap
    expect(r.width).toBeLessThan(4096);
    expect(r.height).toBeLessThan(4096);
    expect(r.container).toBe('mp4');
    expect(r.videoCodec).toBe('h264');
  });

  test('renderPoster honours the profile poster cap', async () => {
    const p = new StubVideoProcessor();
    const profile = getVideoProfile('storage_saver');
    const r = await p.renderPoster({ bytes: new Uint8Array(), profile });
    expect(r.contentType).toBe('image/jpeg');
    expect(r.width).toBeLessThanOrEqual(profile.posterMaxWidth);
    expect(r.height).toBeLessThanOrEqual(profile.posterMaxHeight);
  });

  test('renderTranscode produces H.264 MP4 within profile caps', async () => {
    const p = new StubVideoProcessor();
    const profile = getVideoProfile('balanced');
    const r = await p.renderTranscode({ bytes: new Uint8Array(), profile });
    expect(r.contentType).toBe('video/mp4');
    expect(r.width).toBeLessThanOrEqual(profile.maxWidth);
    expect(r.height).toBeLessThanOrEqual(profile.maxHeight);
    expect(r.durationSeconds).toBeGreaterThan(0);
  });
});

describe('StubDocumentProcessor', () => {
  test('renderFirstPagePreview produces a JPEG preview', async () => {
    const p = new StubDocumentProcessor();
    const r = await p.renderFirstPagePreview({
      bytes: new Uint8Array(),
      sourceContentType: 'application/pdf',
    });
    expect(r.contentType).toBe('image/jpeg');
    expect(r.bytes.byteLength).toBeGreaterThan(0);
    expect(r.width).toBeGreaterThan(0);
    expect(r.height).toBeGreaterThan(0);
  });
});
