/**
 * STORAGE-FU-5-FU-F — ffmpeg `VideoProcessor` integration suite.
 *
 * Exercises the live `FfmpegVideoProcessor` (FU-5-FU-B) against the
 * committed `sample.mp4` fixture.
 *
 * The processor relies on `ffmpeg-static` (bundled via the npm
 * package), so the suite ALWAYS runs in environments where the npm
 * dependency is installed — `describeIfBinary` is used as defense in
 * depth in case `ffmpeg-static` ever fails to resolve at runtime.
 *
 * What the suite proves end-to-end:
 *   - `sample.mp4` probes to the expected H.264 + AAC + 160x120 +
 *     2 seconds.
 *   - `renderPoster` produces a JPEG > 1 KiB (Bug 1 regression guard).
 *   - `renderTranscode` produces an fMP4 > 1 KiB.
 *   - The embedded `comment=STORAGE_FU_5_FU_F_FIXTURE_CANARY` metadata
 *     does NOT survive the transcode (STORAGE-9 metadata-strip
 *     invariant).
 *   - The embedded `title=STORAGE-FU-5-FU-F fixture` metadata does
 *     NOT survive either.
 */
import { expect, test } from 'bun:test';
import { FfmpegVideoProcessor } from '../../../src/infra/processors/ffmpeg-video-processor';
import { getVideoProfile } from '../../../src/actions/handlers/processing/runners/profiles';
import { describeIfBinary, loadFixture } from './_helpers';

describeIfBinary('ffmpeg', 'STORAGE-FU-5-FU-F — FfmpegVideoProcessor integration suite', () => {
  const processor = new FfmpegVideoProcessor();
  const FIXTURE = loadFixture('sample.mp4');

  test('probes the committed MP4 fixture (H.264 + AAC, 160x120, ~2s)', async () => {
    const probe = await processor.probe({ bytes: FIXTURE });
    expect(probe.videoCodec).toBe('h264');
    expect(probe.audioCodec).toBe('aac');
    expect(probe.width).toBe(160);
    expect(probe.height).toBe(120);
    // The fixture is generated with `duration=2`; ffmpeg muxer rounds
    // to nearest frame, so the probe may report 1.95–2.10 s. Use a
    // tolerance window so a future encoder version doesn't break us.
    expect(probe.durationSeconds).toBeGreaterThanOrEqual(1.5);
    expect(probe.durationSeconds).toBeLessThanOrEqual(2.5);
  });

  // ─── Bug 1 (video) regression guard — POSTER ──────────────────────────────
  test('renderPoster produces a JPEG > 1 KiB (Bug 1 regression guard)', async () => {
    const poster = await processor.renderPoster({
      bytes: FIXTURE,
      profile: getVideoProfile('balanced'),
    });
    // Stub-mode poster is 4 bytes (JPEG SOI+EOI markers only).
    expect(poster.bytes.byteLength).toBeGreaterThan(1024);
    expect(poster.contentType).toBe('image/jpeg');
  });

  // ─── Bug 1 (video) regression guard — TRANSCODE ───────────────────────────
  test('renderTranscode produces an fMP4 > 1 KiB', async () => {
    const transcode = await processor.renderTranscode({
      bytes: FIXTURE,
      profile: getVideoProfile('balanced'),
    });
    // Stub-mode transcode is 24 bytes (ftypisom box header only).
    expect(transcode.bytes.byteLength).toBeGreaterThan(1024);
    expect(transcode.contentType).toBe('video/mp4');
  });

  // ─── STORAGE-9 metadata-strip invariant ───────────────────────────────────
  test('renderTranscode strips the embedded `comment` canary metadata', async () => {
    const transcode = await processor.renderTranscode({
      bytes: FIXTURE,
      profile: getVideoProfile('balanced'),
    });
    // The fixture carries `comment=STORAGE_FU_5_FU_F_FIXTURE_CANARY`
    // — the canary substring MUST be absent from the transcode bytes.
    // `-map_metadata -1` in the argv builder is what makes this work.
    const transcodeStr = new TextDecoder('utf-8', { fatal: false }).decode(transcode.bytes);
    expect(transcodeStr).not.toContain('STORAGE_FU_5_FU_F_FIXTURE_CANARY');
  });

  test('renderTranscode strips the embedded `title` metadata', async () => {
    const transcode = await processor.renderTranscode({
      bytes: FIXTURE,
      profile: getVideoProfile('balanced'),
    });
    const transcodeStr = new TextDecoder('utf-8', { fatal: false }).decode(transcode.bytes);
    expect(transcodeStr).not.toContain('STORAGE-FU-5-FU-F fixture');
  });

  test('renderPoster strips embedded metadata too (no canary in JPEG bytes)', async () => {
    const poster = await processor.renderPoster({
      bytes: FIXTURE,
      profile: getVideoProfile('balanced'),
    });
    const posterStr = new TextDecoder('utf-8', { fatal: false }).decode(poster.bytes);
    expect(posterStr).not.toContain('STORAGE_FU_5_FU_F_FIXTURE_CANARY');
    expect(posterStr).not.toContain('STORAGE-FU-5-FU-F fixture');
  });
});
