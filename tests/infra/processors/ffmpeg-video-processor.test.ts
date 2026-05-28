/**
 * STORAGE-FU-5-FU-B — `FfmpegVideoProcessor` unit tests.
 *
 * Test posture mirrors `sharp-image-processor.test.ts`:
 *
 *   1. **Pure parser tests** — `parseFfmpegProbe` is exercised against
 *      hand-built stderr fixtures (real ffmpeg 6.0 stderr lines + a
 *      collection of malformed shapes). No `ffmpeg` spawn.
 *   2. **Argv builder tests** — assert the ffmpeg argv is constructed
 *      from the closed-set profile + fixed flags, NEVER from user
 *      input. Defense-in-depth against argv injection.
 *   3. **Spawner-injected processor tests** — `FfmpegVideoProcessor`
 *      with a fake `FfmpegSpawner` exercises every probe / render
 *      branch deterministically.
 *   4. **One real-ffmpeg integration test** at the bottom (the Bug 1
 *      regression guard) — generates a small MP4 via `ffmpeg-static`,
 *      runs it through the live processor, and asserts the variants
 *      are real bytes > 1024 (poster) / > 1024 (transcode).
 *
 * SECURITY invariants verified:
 *   - **Metadata stripping is MANDATORY.** `-map_metadata -1` MUST
 *     appear in every poster + transcode argv. Asserted at the
 *     argv-builder level (cheap, deterministic) AND end-to-end
 *     against a real ffmpeg run.
 *   - **ffmpeg argv contains no shell metacharacters / no user data.**
 *     Asserted by checking the argv is an array of fixed flags +
 *     numeric profile values; profile fields are typed numbers in the
 *     closed `VideoProfile` interface.
 *   - **No filesystem temp files.** Every argv reads `pipe:0` and
 *     writes `pipe:1` (poster + transcode) or `-` (probe / null
 *     muxer). Asserted by scanning the argv for any non-pipe filename
 *     reference.
 *   - **Closed-set runner errors only.** Library / SDK error text
 *     NEVER leaks through `RunnerInputError.message` or
 *     `RunnerExecutionError.message`.
 *   - **Process timeout enforced.** A spawner that reports
 *     `timedOut: true` surfaces as retryable `PROCESSOR_FAILED`.
 *   - **Process exit code respected.** Non-zero exit → retryable
 *     `PROCESSOR_FAILED` for poster / transcode (probe relies on
 *     stderr parsing not exit code).
 *   - **Bytes copied on return.** Caller receives a fresh
 *     `Uint8Array` — not the same instance the spawner returned.
 */
import { describe, expect, test } from 'bun:test';
import {
  RunnerExecutionError,
  RunnerInputError,
} from '../../../src/actions/handlers/processing/runners/errors';
import {
  getVideoProfile,
  MAX_VIDEO_DIMENSION,
  MAX_VIDEO_DURATION_SECONDS,
  type VideoProfile,
} from '../../../src/actions/handlers/processing/runners/profiles';
import {
  DEFAULT_FFMPEG_TIMEOUT_MS,
  defaultBunSpawner,
  FfmpegVideoProcessor,
  __forTesting__,
  type FfmpegSpawner,
} from '../../../src/infra/processors/ffmpeg-video-processor';

// ── stderr fixtures ──────────────────────────────────────────────────────

/** Real ffmpeg 6.0 stderr block for a 720p 30 fps H.264 + AAC MP4. */
const HEALTHY_STDERR = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'pipe:0':
  Metadata:
    major_brand     : isom
    minor_version   : 512
    compatible_brands: isomiso6iso2avc1mp41
    encoder         : Lavf60.3.100
  Duration: 00:00:30.50, start: 0.000000, bitrate: 1850 kb/s
  Stream #0:0[0x1](und): Video: h264 (Constrained Baseline) (avc1 / 0x31637661), yuv420p(progressive), 1280x720 [SAR 1:1 DAR 16:9], 1700 kb/s, 30 fps, 30 tbr, 15360 tbn (default)
    Metadata:
      handler_name    : VideoHandler
      vendor_id       : [0][0][0][0]
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 128 kb/s (default)
Stream mapping:
  Stream #0:0 -> #0:0 (h264 (native) -> wrapped_avframe (native))
Output #0, null, to 'pipe:':
  Metadata:
    encoder         : Lavf60.3.100
  Stream #0:0(und): Video: wrapped_avframe, yuv420p(progressive), 1280x720 [SAR 1:1 DAR 16:9], q=2-31, 200 kb/s, 30 fps, 30 tbn (default)
frame=  915 fps=0.0 q=-0.0 Lsize=N/A time=00:00:30.50 bitrate=N/A speed= 515x
video:5kB audio:0kB
`;

const NO_VIDEO_STREAM_STDERR = `Input #0, wav, from 'pipe:0':
  Duration: 00:00:05.00, start: 0.000000, bitrate: 1411 kb/s
  Stream #0:0: Audio: pcm_s16le ([1][0][0][0] / 0x0001), 44100 Hz, stereo, s16, 1411 kb/s
`;

const ROTATED_STDERR = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'pipe:0':
  Duration: 00:00:10.00, start: 0.000000, bitrate: 1000 kb/s
  Stream #0:0[0x1](und): Video: h264, yuv420p, 1920x1080, 30 fps, 30 tbr (default)
    Side data:
      displaymatrix: rotation of -90.00 degrees
    Metadata:
      handler_name    : VideoHandler
`;

const ROTATED_LEGACY_STDERR = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'pipe:0':
  Duration: 00:00:10.00, start: 0.000000, bitrate: 1000 kb/s
  Stream #0:0[0x1](und): Video: h264, yuv420p, 1920x1080, 30 fps, 30 tbr (default)
    Metadata:
      handler_name    : VideoHandler
      rotate          : 90
`;

const OVER_CAP_STDERR = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'pipe:0':
  Duration: 00:00:30.00, start: 0.000000, bitrate: 50000 kb/s
  Stream #0:0[0x1](und): Video: h264, yuv420p, 8192x4320, 60 fps, 60 tbr (default)
`;

const OVER_DURATION_STDERR = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'pipe:0':
  Duration: 02:30:00.00, start: 0.000000, bitrate: 1000 kb/s
  Stream #0:0[0x1](und): Video: h264, yuv420p, 1280x720, 30 fps, 30 tbr (default)
`;

// ── helpers ──────────────────────────────────────────────────────────────

function spawnerReturning(result: {
  stdout?: Uint8Array;
  stderr?: string;
  exitCode?: number | null;
  timedOut?: boolean;
}): FfmpegSpawner {
  return {
    async run() {
      return {
        stdout: result.stdout ?? new Uint8Array(),
        stderr: result.stderr ?? '',
        exitCode: result.exitCode ?? 0,
        timedOut: result.timedOut ?? false,
      };
    },
  };
}

function spawnerThrowing(err: Error): FfmpegSpawner {
  return {
    async run() {
      throw err;
    },
  };
}

function spawnerCapturing(): {
  spawner: FfmpegSpawner;
  calls: Array<{
    argv: readonly string[];
    stdin: Uint8Array;
    timeoutMs: number;
    kind: string;
  }>;
  result: {
    stdout?: Uint8Array;
    stderr?: string;
    exitCode?: number | null;
    timedOut?: boolean;
  };
} {
  const calls: Array<{
    argv: readonly string[];
    stdin: Uint8Array;
    timeoutMs: number;
    kind: string;
  }> = [];
  const result: {
    stdout?: Uint8Array;
    stderr?: string;
    exitCode?: number | null;
    timedOut?: boolean;
  } = {};
  const spawner: FfmpegSpawner = {
    async run(input) {
      calls.push({
        argv: input.argv,
        stdin: input.stdin,
        timeoutMs: input.timeoutMs,
        kind: input.kind,
      });
      return {
        stdout: result.stdout ?? new Uint8Array(),
        stderr: result.stderr ?? '',
        exitCode: result.exitCode ?? 0,
        timedOut: result.timedOut ?? false,
      };
    },
  };
  return { spawner, calls, result };
}

const FAKE_PROFILE: VideoProfile = getVideoProfile('balanced');

// ── parser: parseFfmpegProbe ─────────────────────────────────────────────

describe('parseFfmpegProbe — happy paths', () => {
  test('parses duration, dimensions, codecs, container from a healthy mp4 stderr', () => {
    const parsed = __forTesting__.parseFfmpegProbe(HEALTHY_STDERR);
    expect(parsed.durationSeconds).toBe(30.5);
    expect(parsed.width).toBe(1280);
    expect(parsed.height).toBe(720);
    expect(parsed.videoCodec).toBe('h264');
    expect(parsed.audioCodec).toBe('aac');
    expect(parsed.container).toBe('mov');
    expect(parsed.rotationDegrees).toBeNull();
  });

  test('parses rotation from displaymatrix (newer ffmpeg)', () => {
    const parsed = __forTesting__.parseFfmpegProbe(ROTATED_STDERR);
    expect(parsed.rotationDegrees).toBe(-90);
  });

  test('parses rotation from legacy `rotate:` metadata', () => {
    const parsed = __forTesting__.parseFfmpegProbe(ROTATED_LEGACY_STDERR);
    expect(parsed.rotationDegrees).toBe(90);
  });

  test('parses over-cap dimensions (parser does NOT enforce cap)', () => {
    const parsed = __forTesting__.parseFfmpegProbe(OVER_CAP_STDERR);
    expect(parsed.width).toBe(8192);
    expect(parsed.height).toBe(4320);
  });

  test('parses over-cap duration (parser does NOT enforce cap)', () => {
    const parsed = __forTesting__.parseFfmpegProbe(OVER_DURATION_STDERR);
    expect(parsed.durationSeconds).toBe(2 * 3600 + 30 * 60);
  });

  test('audio codec null when no audio stream present', () => {
    const noAudio = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'pipe:0':
  Duration: 00:00:05.00, start: 0.000000, bitrate: 1000 kb/s
  Stream #0:0[0x1](und): Video: h264, yuv420p, 640x480, 30 fps, 30 tbr (default)
`;
    const parsed = __forTesting__.parseFfmpegProbe(noAudio);
    expect(parsed.audioCodec).toBeNull();
    expect(parsed.videoCodec).toBe('h264');
  });
});

describe('parseFfmpegProbe — malformed inputs', () => {
  test('empty stderr yields all nulls', () => {
    const parsed = __forTesting__.parseFfmpegProbe('');
    expect(parsed.durationSeconds).toBeNull();
    expect(parsed.width).toBeNull();
    expect(parsed.height).toBeNull();
    expect(parsed.videoCodec).toBeNull();
    expect(parsed.audioCodec).toBeNull();
    expect(parsed.container).toBeNull();
  });

  test('no video stream → videoCodec null + dimensions null', () => {
    const parsed = __forTesting__.parseFfmpegProbe(NO_VIDEO_STREAM_STDERR);
    expect(parsed.videoCodec).toBeNull();
    expect(parsed.width).toBeNull();
    expect(parsed.height).toBeNull();
    // Audio still parses cleanly.
    expect(parsed.audioCodec).toBe('pcm_s16le');
  });

  test('malformed duration line is skipped without error', () => {
    const parsed = __forTesting__.parseFfmpegProbe(
      'Duration: BOGUS, start: 0\nStream #0:0: Video: h264, yuv420p, 100x100',
    );
    expect(parsed.durationSeconds).toBeNull();
    expect(parsed.videoCodec).toBe('h264');
  });

  test('parser does not throw on adversarial input', () => {
    expect(() => __forTesting__.parseFfmpegProbe('\x00\x01\x02')).not.toThrow();
    expect(() =>
      __forTesting__.parseFfmpegProbe('Duration: '.repeat(10000) + 'garbage'),
    ).not.toThrow();
  });
});

// ── argv builders ────────────────────────────────────────────────────────

describe('buildProbeArgv', () => {
  test('argv carries fixed flags + pipe:0 input + null output', () => {
    const argv = __forTesting__.buildProbeArgv('/usr/bin/ffmpeg');
    expect(argv).toEqual(['/usr/bin/ffmpeg', '-hide_banner', '-i', 'pipe:0', '-f', 'null', '-']);
  });

  test('argv never references a filesystem path beyond the binary', () => {
    const argv = __forTesting__.buildProbeArgv('/usr/bin/ffmpeg');
    // Every non-binary, non-flag, non-pipe argv entry is a known
    // closed-set value.
    for (const entry of argv.slice(1)) {
      expect(entry).toMatch(/^(-[a-z_]+|pipe:[01]|null|-)$/);
    }
  });
});

describe('buildPosterArgv', () => {
  test('includes -map_metadata -1 for STORAGE-9 stripping', () => {
    const argv = __forTesting__.buildPosterArgv('/usr/bin/ffmpeg', FAKE_PROFILE);
    const idx = argv.indexOf('-map_metadata');
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe('-1');
  });

  test('reads pipe:0 and writes pipe:1 (no filesystem temp file)', () => {
    const argv = __forTesting__.buildPosterArgv('/usr/bin/ffmpeg', FAKE_PROFILE);
    expect(argv).toContain('pipe:0');
    expect(argv).toContain('pipe:1');
    // No non-pipe filename references.
    for (const entry of argv) {
      expect(entry).not.toMatch(/\/tmp|\/var|\/private/i);
    }
  });

  test('honours profile.posterMaxWidth / posterMaxHeight in scale filter', () => {
    const profile: VideoProfile = { ...FAKE_PROFILE, posterMaxWidth: 320, posterMaxHeight: 240 };
    const argv = __forTesting__.buildPosterArgv('/usr/bin/ffmpeg', profile);
    const vfIdx = argv.indexOf('-vf');
    expect(vfIdx).toBeGreaterThan(-1);
    expect(argv[vfIdx + 1]).toContain('320');
    expect(argv[vfIdx + 1]).toContain('240');
  });

  test('emits a single frame in MJPEG', () => {
    const argv = __forTesting__.buildPosterArgv('/usr/bin/ffmpeg', FAKE_PROFILE);
    expect(argv).toContain('mjpeg');
    expect(argv).toContain('-frames:v');
    const fIdx = argv.indexOf('-frames:v');
    expect(argv[fIdx + 1]).toBe('1');
  });
});

describe('buildTranscodeArgv', () => {
  test('includes -map_metadata -1 for STORAGE-9 stripping', () => {
    const argv = __forTesting__.buildTranscodeArgv('/usr/bin/ffmpeg', FAKE_PROFILE);
    const idx = argv.indexOf('-map_metadata');
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe('-1');
  });

  test('uses libx264 + aac codecs (MVP closed set)', () => {
    const argv = __forTesting__.buildTranscodeArgv('/usr/bin/ffmpeg', FAKE_PROFILE);
    const vIdx = argv.indexOf('-c:v');
    const aIdx = argv.indexOf('-c:a');
    expect(argv[vIdx + 1]).toBe('libx264');
    expect(argv[aIdx + 1]).toBe('aac');
  });

  test('emits fragmented MP4 so the muxer writes to a pipe', () => {
    const argv = __forTesting__.buildTranscodeArgv('/usr/bin/ffmpeg', FAKE_PROFILE);
    const mIdx = argv.indexOf('-movflags');
    expect(mIdx).toBeGreaterThan(-1);
    expect(argv[mIdx + 1]).toContain('frag_keyframe');
    expect(argv[mIdx + 1]).toContain('empty_moov');
  });

  test('honours profile.maxWidth / maxHeight + targetBitrateKbps', () => {
    const profile: VideoProfile = {
      ...FAKE_PROFILE,
      maxWidth: 854,
      maxHeight: 480,
      targetBitrateKbps: 1200,
    };
    const argv = __forTesting__.buildTranscodeArgv('/usr/bin/ffmpeg', profile);
    const vfIdx = argv.indexOf('-vf');
    expect(argv[vfIdx + 1]).toContain('854');
    expect(argv[vfIdx + 1]).toContain('480');
    const bvIdx = argv.indexOf('-b:v');
    expect(argv[bvIdx + 1]).toBe('1200k');
  });

  test('reads pipe:0 and writes pipe:1 (no filesystem temp file)', () => {
    const argv = __forTesting__.buildTranscodeArgv('/usr/bin/ffmpeg', FAKE_PROFILE);
    expect(argv).toContain('pipe:0');
    expect(argv).toContain('pipe:1');
    for (const entry of argv) {
      expect(entry).not.toMatch(/\/tmp|\/var|\/private/i);
    }
  });

  test('argv contains no shell metacharacters', () => {
    // Defense in depth — Bun.spawn invokes the binary directly with
    // an argv array, never via a shell. But assert anyway so a
    // future refactor that switches to `shell: true` immediately
    // trips the regression guard. We check for command separators
    // (`;`, `|`, `&`), command substitution (`` ` ``, `$(`), and
    // redirection (`<`, `>`). Bare parens are legitimate inside
    // ffmpeg's `min(W,iw)` scale filter expression and are not
    // shell-dangerous when passed as a single argv element.
    const argv = __forTesting__.buildTranscodeArgv('/usr/bin/ffmpeg', FAKE_PROFILE);
    for (const entry of argv) {
      expect(entry).not.toMatch(/[;&|`<>]/);
      expect(entry).not.toMatch(/\$\(/);
    }
  });
});

// ── FfmpegVideoProcessor.probe ───────────────────────────────────────────

describe('FfmpegVideoProcessor.probe', () => {
  test('returns parsed dimensions / codecs / duration for a healthy mp4', async () => {
    const spawner = spawnerReturning({ stderr: HEALTHY_STDERR, exitCode: 0 });
    const proc = new FfmpegVideoProcessor({ spawner, ffmpegPath: '/dev/null' });
    const probe = await proc.probe({ bytes: new Uint8Array([0]) });
    expect(probe.width).toBe(1280);
    expect(probe.height).toBe(720);
    expect(probe.durationSeconds).toBe(30.5);
    expect(probe.videoCodec).toBe('h264');
    expect(probe.audioCodec).toBe('aac');
    expect(probe.container).toBe('mov');
    expect(probe.rotationDegrees).toBeNull();
  });

  test('no video stream → RunnerInputError(UNSUPPORTED_FORMAT)', async () => {
    const spawner = spawnerReturning({ stderr: NO_VIDEO_STREAM_STDERR, exitCode: 0 });
    const proc = new FfmpegVideoProcessor({ spawner, ffmpegPath: '/dev/null' });
    try {
      await proc.probe({ bytes: new Uint8Array([0]) });
      throw new Error('did not throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RunnerInputError);
      expect((err as RunnerInputError).code).toBe('UNSUPPORTED_FORMAT');
      expect((err as RunnerInputError).retryable).toBe(false);
    }
  });

  test('over-cap dimensions → RunnerInputError(OVER_MAX_DIMENSIONS)', async () => {
    const spawner = spawnerReturning({ stderr: OVER_CAP_STDERR, exitCode: 0 });
    const proc = new FfmpegVideoProcessor({ spawner, ffmpegPath: '/dev/null' });
    try {
      await proc.probe({ bytes: new Uint8Array([0]) });
      throw new Error('did not throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RunnerInputError);
      expect((err as RunnerInputError).code).toBe('OVER_MAX_DIMENSIONS');
    }
  });

  test('over-cap duration → RunnerInputError(OVER_MAX_DURATION)', async () => {
    const spawner = spawnerReturning({ stderr: OVER_DURATION_STDERR, exitCode: 0 });
    const proc = new FfmpegVideoProcessor({ spawner, ffmpegPath: '/dev/null' });
    try {
      await proc.probe({ bytes: new Uint8Array([0]) });
      throw new Error('did not throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RunnerInputError);
      expect((err as RunnerInputError).code).toBe('OVER_MAX_DURATION');
    }
  });

  test('exactly at MAX_VIDEO_DIMENSION is accepted (off-by-one guard)', async () => {
    const stderr = `Input #0, mp4, from 'pipe:0':
  Duration: 00:00:10.00, start: 0.000000, bitrate: 1000 kb/s
  Stream #0:0: Video: h264, yuv420p, ${MAX_VIDEO_DIMENSION}x720, 30 fps`;
    const spawner = spawnerReturning({ stderr, exitCode: 0 });
    const proc = new FfmpegVideoProcessor({ spawner, ffmpegPath: '/dev/null' });
    const probe = await proc.probe({ bytes: new Uint8Array([0]) });
    expect(probe.width).toBe(MAX_VIDEO_DIMENSION);
  });

  test('exactly at MAX_VIDEO_DURATION_SECONDS is accepted (off-by-one guard)', async () => {
    const totalS = MAX_VIDEO_DURATION_SECONDS;
    const h = Math.floor(totalS / 3600);
    const m = Math.floor((totalS - h * 3600) / 60);
    const s = totalS - h * 3600 - m * 60;
    const dur = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.00`;
    const stderr = `Input #0, mp4, from 'pipe:0':
  Duration: ${dur}, start: 0.000000, bitrate: 1000 kb/s
  Stream #0:0: Video: h264, yuv420p, 1280x720, 30 fps`;
    const spawner = spawnerReturning({ stderr, exitCode: 0 });
    const proc = new FfmpegVideoProcessor({ spawner, ffmpegPath: '/dev/null' });
    const probe = await proc.probe({ bytes: new Uint8Array([0]) });
    expect(probe.durationSeconds).toBe(MAX_VIDEO_DURATION_SECONDS);
  });

  test('spawner throw → RunnerExecutionError(PROCESSOR_FAILED, retryable)', async () => {
    const proc = new FfmpegVideoProcessor({
      spawner: spawnerThrowing(new Error('spawn EAGAIN')),
      ffmpegPath: '/dev/null',
    });
    try {
      await proc.probe({ bytes: new Uint8Array([0]) });
      throw new Error('did not throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RunnerExecutionError);
      expect((err as RunnerExecutionError).code).toBe('PROCESSOR_FAILED');
      expect((err as RunnerExecutionError).retryable).toBe(true);
    }
  });

  test('spawner timeout → RunnerExecutionError(PROCESSOR_FAILED, retryable)', async () => {
    const spawner = spawnerReturning({ timedOut: true, exitCode: null });
    const proc = new FfmpegVideoProcessor({ spawner, ffmpegPath: '/dev/null' });
    try {
      await proc.probe({ bytes: new Uint8Array([0]) });
      throw new Error('did not throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RunnerExecutionError);
      expect((err as RunnerExecutionError).code).toBe('PROCESSOR_FAILED');
      expect((err as RunnerExecutionError).retryable).toBe(true);
    }
  });

  test('error message NEVER carries raw library text', async () => {
    const proc = new FfmpegVideoProcessor({
      spawner: spawnerThrowing(
        new Error('ffmpeg: avformat_open_input failed @ /private/tmp/x.mp4'),
      ),
      ffmpegPath: '/dev/null',
    });
    try {
      await proc.probe({ bytes: new Uint8Array([0]) });
      throw new Error('did not throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RunnerExecutionError);
      // The closed-set code IS the message — no library hint leaks.
      expect((err as Error).message).toBe('PROCESSOR_FAILED');
      expect((err as Error).message).not.toMatch(/ffmpeg|avformat|libav|\/tmp/i);
    }
  });

  test('zero/negative dimensions → UNSUPPORTED_FORMAT (defensive)', async () => {
    const stderr = `Input #0, mp4, from 'pipe:0':
  Duration: 00:00:10.00, start: 0.000000, bitrate: 1000 kb/s
  Stream #0:0: Video: h264, yuv420p, 0x0`;
    const spawner = spawnerReturning({ stderr, exitCode: 0 });
    const proc = new FfmpegVideoProcessor({ spawner, ffmpegPath: '/dev/null' });
    try {
      await proc.probe({ bytes: new Uint8Array([0]) });
      throw new Error('did not throw');
    } catch (err) {
      // The dimensions regex requires 2+ digits so 0x0 is treated as
      // "no dimensions found" → UNSUPPORTED_FORMAT.
      expect(err).toBeInstanceOf(RunnerInputError);
      expect((err as RunnerInputError).code).toBe('UNSUPPORTED_FORMAT');
    }
  });

  test('missing duration → UNSUPPORTED_FORMAT', async () => {
    const stderr = `Input #0, mp4, from 'pipe:0':
  Stream #0:0: Video: h264, yuv420p, 1280x720, 30 fps`;
    const spawner = spawnerReturning({ stderr, exitCode: 0 });
    const proc = new FfmpegVideoProcessor({ spawner, ffmpegPath: '/dev/null' });
    try {
      await proc.probe({ bytes: new Uint8Array([0]) });
      throw new Error('did not throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RunnerInputError);
      expect((err as RunnerInputError).code).toBe('UNSUPPORTED_FORMAT');
    }
  });
});

// ── FfmpegVideoProcessor.renderPoster ────────────────────────────────────

describe('FfmpegVideoProcessor.renderPoster', () => {
  test('returns image/jpeg + bytes copied from spawner stdout', async () => {
    const spawnerOut = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const spawner = spawnerReturning({ stdout: spawnerOut, exitCode: 0 });
    const proc = new FfmpegVideoProcessor({ spawner, ffmpegPath: '/dev/null' });
    const render = await proc.renderPoster({
      bytes: new Uint8Array([0]),
      profile: FAKE_PROFILE,
    });
    expect(render.contentType).toBe('image/jpeg');
    expect(render.bytes.length).toBe(spawnerOut.length);
    expect(render.bytes[0]).toBe(0xff);
    expect(render.bytes[1]).toBe(0xd8);
  });

  test('bytes are copied into a fresh Uint8Array (caller never observes spawner ArrayBuffer)', async () => {
    const spawnerOut = new Uint8Array([1, 2, 3, 4, 5]);
    const spawner = spawnerReturning({ stdout: spawnerOut, exitCode: 0 });
    const proc = new FfmpegVideoProcessor({ spawner, ffmpegPath: '/dev/null' });
    const render = await proc.renderPoster({
      bytes: new Uint8Array([0]),
      profile: FAKE_PROFILE,
    });
    expect(render.bytes).not.toBe(spawnerOut);
    expect(render.bytes.buffer).not.toBe(spawnerOut.buffer);
  });

  test('width/height matches profile poster cap', async () => {
    const spawner = spawnerReturning({ stdout: new Uint8Array([1]), exitCode: 0 });
    const proc = new FfmpegVideoProcessor({ spawner, ffmpegPath: '/dev/null' });
    const render = await proc.renderPoster({
      bytes: new Uint8Array([0]),
      profile: FAKE_PROFILE,
    });
    expect(render.width).toBe(FAKE_PROFILE.posterMaxWidth);
    expect(render.height).toBe(FAKE_PROFILE.posterMaxHeight);
  });

  test('non-zero exit code → RunnerExecutionError(PROCESSOR_FAILED)', async () => {
    const spawner = spawnerReturning({ stdout: new Uint8Array([1]), exitCode: 1 });
    const proc = new FfmpegVideoProcessor({ spawner, ffmpegPath: '/dev/null' });
    try {
      await proc.renderPoster({ bytes: new Uint8Array([0]), profile: FAKE_PROFILE });
      throw new Error('did not throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RunnerExecutionError);
      expect((err as RunnerExecutionError).code).toBe('PROCESSOR_FAILED');
      expect((err as RunnerExecutionError).retryable).toBe(true);
    }
  });

  test('empty stdout → RunnerExecutionError(PROCESSOR_FAILED)', async () => {
    const spawner = spawnerReturning({ stdout: new Uint8Array(), exitCode: 0 });
    const proc = new FfmpegVideoProcessor({ spawner, ffmpegPath: '/dev/null' });
    try {
      await proc.renderPoster({ bytes: new Uint8Array([0]), profile: FAKE_PROFILE });
      throw new Error('did not throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RunnerExecutionError);
      expect((err as RunnerExecutionError).code).toBe('PROCESSOR_FAILED');
    }
  });

  test('spawner throw → RunnerExecutionError(PROCESSOR_FAILED, retryable)', async () => {
    const proc = new FfmpegVideoProcessor({
      spawner: spawnerThrowing(new Error('boom')),
      ffmpegPath: '/dev/null',
    });
    try {
      await proc.renderPoster({ bytes: new Uint8Array([0]), profile: FAKE_PROFILE });
      throw new Error('did not throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RunnerExecutionError);
      expect((err as RunnerExecutionError).code).toBe('PROCESSOR_FAILED');
      expect((err as RunnerExecutionError).retryable).toBe(true);
    }
  });

  test('timeout → RunnerExecutionError(PROCESSOR_FAILED, retryable)', async () => {
    const spawner = spawnerReturning({
      stdout: new Uint8Array(),
      exitCode: null,
      timedOut: true,
    });
    const proc = new FfmpegVideoProcessor({ spawner, ffmpegPath: '/dev/null' });
    try {
      await proc.renderPoster({ bytes: new Uint8Array([0]), profile: FAKE_PROFILE });
      throw new Error('did not throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RunnerExecutionError);
      expect((err as RunnerExecutionError).code).toBe('PROCESSOR_FAILED');
    }
  });
});

// ── FfmpegVideoProcessor.renderTranscode ─────────────────────────────────

describe('FfmpegVideoProcessor.renderTranscode', () => {
  test('returns video/mp4 + bytes from spawner stdout', async () => {
    const spawnerOut = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
    const spawner = spawnerReturning({ stdout: spawnerOut, exitCode: 0 });
    const proc = new FfmpegVideoProcessor({ spawner, ffmpegPath: '/dev/null' });
    const render = await proc.renderTranscode({
      bytes: new Uint8Array([0]),
      profile: FAKE_PROFILE,
    });
    expect(render.contentType).toBe('video/mp4');
    expect(render.bytes.length).toBe(spawnerOut.length);
  });

  test('width/height matches profile cap', async () => {
    const spawner = spawnerReturning({ stdout: new Uint8Array([1]), exitCode: 0 });
    const proc = new FfmpegVideoProcessor({ spawner, ffmpegPath: '/dev/null' });
    const render = await proc.renderTranscode({
      bytes: new Uint8Array([0]),
      profile: FAKE_PROFILE,
    });
    expect(render.width).toBe(FAKE_PROFILE.maxWidth);
    expect(render.height).toBe(FAKE_PROFILE.maxHeight);
  });

  test('durationSeconds reported as 0 (not fabricated)', async () => {
    const spawner = spawnerReturning({ stdout: new Uint8Array([1]), exitCode: 0 });
    const proc = new FfmpegVideoProcessor({ spawner, ffmpegPath: '/dev/null' });
    const render = await proc.renderTranscode({
      bytes: new Uint8Array([0]),
      profile: FAKE_PROFILE,
    });
    // We deliberately do NOT re-probe the transcode output (would
    // double the per-job cost). 0 is the honest "unknown" signal.
    expect(render.durationSeconds).toBe(0);
  });

  test('non-zero exit code → RunnerExecutionError(PROCESSOR_FAILED, retryable)', async () => {
    const spawner = spawnerReturning({ stdout: new Uint8Array([1]), exitCode: 137 });
    const proc = new FfmpegVideoProcessor({ spawner, ffmpegPath: '/dev/null' });
    try {
      await proc.renderTranscode({ bytes: new Uint8Array([0]), profile: FAKE_PROFILE });
      throw new Error('did not throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RunnerExecutionError);
      expect((err as RunnerExecutionError).code).toBe('PROCESSOR_FAILED');
    }
  });

  test('empty stdout → RunnerExecutionError(PROCESSOR_FAILED)', async () => {
    const spawner = spawnerReturning({ stdout: new Uint8Array(), exitCode: 0 });
    const proc = new FfmpegVideoProcessor({ spawner, ffmpegPath: '/dev/null' });
    try {
      await proc.renderTranscode({ bytes: new Uint8Array([0]), profile: FAKE_PROFILE });
      throw new Error('did not throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RunnerExecutionError);
      expect((err as RunnerExecutionError).code).toBe('PROCESSOR_FAILED');
    }
  });

  test('spawner throw → RunnerExecutionError(PROCESSOR_FAILED)', async () => {
    const proc = new FfmpegVideoProcessor({
      spawner: spawnerThrowing(new Error('boom')),
      ffmpegPath: '/dev/null',
    });
    try {
      await proc.renderTranscode({ bytes: new Uint8Array([0]), profile: FAKE_PROFILE });
      throw new Error('did not throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RunnerExecutionError);
      expect((err as RunnerExecutionError).code).toBe('PROCESSOR_FAILED');
    }
  });
});

// ── spawner contract ─────────────────────────────────────────────────────

describe('FfmpegVideoProcessor — spawner contract', () => {
  test('probe forwards stdin bytes + uses kind=probe', async () => {
    const captured: Array<{ argv: readonly string[]; stdin: Uint8Array; kind: string }> = [];
    const sp: FfmpegSpawner = {
      async run(input) {
        captured.push({ argv: input.argv, stdin: input.stdin, kind: input.kind });
        return { stdout: new Uint8Array(), stderr: HEALTHY_STDERR, exitCode: 0, timedOut: false };
      },
    };
    const proc = new FfmpegVideoProcessor({ spawner: sp, ffmpegPath: '/dev/null' });
    const bytes = new Uint8Array([42, 43, 44]);
    await proc.probe({ bytes });
    expect(captured[0].kind).toBe('probe');
    expect(captured[0].stdin).toBe(bytes);
  });

  test('renderPoster forwards stdin + uses kind=poster', async () => {
    const { spawner, calls, result } = spawnerCapturing();
    result.stdout = new Uint8Array([0xff, 0xd8]);
    const proc = new FfmpegVideoProcessor({ spawner, ffmpegPath: '/dev/null' });
    const bytes = new Uint8Array([1, 2, 3]);
    await proc.renderPoster({ bytes, profile: FAKE_PROFILE });
    expect(calls.length).toBe(1);
    expect(calls[0].kind).toBe('poster');
    expect(calls[0].stdin).toBe(bytes);
  });

  test('renderTranscode forwards stdin + uses kind=transcode', async () => {
    const { spawner, calls, result } = spawnerCapturing();
    result.stdout = new Uint8Array([0x00, 0x00, 0x00, 0x18]);
    const proc = new FfmpegVideoProcessor({ spawner, ffmpegPath: '/dev/null' });
    const bytes = new Uint8Array([1, 2, 3]);
    await proc.renderTranscode({ bytes, profile: FAKE_PROFILE });
    expect(calls.length).toBe(1);
    expect(calls[0].kind).toBe('transcode');
    expect(calls[0].stdin).toBe(bytes);
  });

  test('default timeoutMs is forwarded to the spawner', async () => {
    const { spawner, calls, result } = spawnerCapturing();
    result.stderr = HEALTHY_STDERR;
    const proc = new FfmpegVideoProcessor({ spawner, ffmpegPath: '/dev/null' });
    await proc.probe({ bytes: new Uint8Array([0]) });
    expect(calls[0].timeoutMs).toBe(DEFAULT_FFMPEG_TIMEOUT_MS);
  });

  test('caller-supplied timeoutMs overrides the default', async () => {
    const { spawner, calls, result } = spawnerCapturing();
    result.stderr = HEALTHY_STDERR;
    const proc = new FfmpegVideoProcessor({
      spawner,
      ffmpegPath: '/dev/null',
      timeoutMs: 99_000,
    });
    await proc.probe({ bytes: new Uint8Array([0]) });
    expect(calls[0].timeoutMs).toBe(99_000);
  });

  test('argv first entry is the ffmpegPath constructor arg', async () => {
    const { spawner, calls, result } = spawnerCapturing();
    result.stderr = HEALTHY_STDERR;
    const proc = new FfmpegVideoProcessor({
      spawner,
      ffmpegPath: '/special/path/to/ffmpeg',
    });
    await proc.probe({ bytes: new Uint8Array([0]) });
    expect(calls[0].argv[0]).toBe('/special/path/to/ffmpeg');
  });
});

// ── resolveDefaultFfmpegPath ─────────────────────────────────────────────

describe('resolveDefaultFfmpegPath', () => {
  test('returns a non-empty string when ffmpeg-static is installed', () => {
    // ffmpeg-static is listed as a runtime dependency; the test
    // environment has it installed so this MUST resolve.
    const path = __forTesting__.resolveDefaultFfmpegPath();
    expect(typeof path).toBe('string');
    expect(path.length).toBeGreaterThan(0);
    expect(path).toContain('ffmpeg');
  });
});

// ── defaultBunSpawner — only a smoke ────────────────────────────────────

describe('defaultBunSpawner', () => {
  test('is exported and is a callable object', () => {
    expect(defaultBunSpawner).toBeDefined();
    expect(typeof defaultBunSpawner.run).toBe('function');
  });
});

// ── STORAGE-FU-5-FU-B: Bug 1 regression guard (REAL ffmpeg) ──────────────

/**
 * STORAGE-FU-5-FU-B — Bug 1 regression guard for video variants.
 *
 * Before FU-B landed, a `video_transcode` / `video_thumbnail` job in
 * live mode produced bytes of fixed-size stub artefacts (24-byte
 * `ftypisom` for transcode, 4-byte JPEG SOI+EOI for poster) or
 * `UNSUPPORTED_FORMAT` from the production stub. This test runs the
 * real `FfmpegVideoProcessor` against an in-memory MP4 produced by
 * `ffmpeg-static` itself and asserts:
 *
 *   1. probe returns honest probe data (duration > 0, dimensions,
 *      h264/aac codecs).
 *   2. renderPoster produces a real JPEG (> 1024 bytes).
 *   3. renderTranscode produces a real fMP4 (> 1024 bytes,
 *      `ftyp` box magic).
 *   4. The transcode output does NOT carry the source comment
 *      metadata field — `-map_metadata -1` works end-to-end.
 */
describe('FfmpegVideoProcessor — STORAGE-FU-5-FU-B: real ffmpeg integration (Bug 1 guard)', () => {
  async function generateSourceMp4(): Promise<Uint8Array> {
    const ffmpegPath = __forTesting__.resolveDefaultFfmpegPath();
    // 2-second 160x120 H.264 with AAC audio + an EMBEDDED COMMENT
    // metadata field. The comment field is the canary: after our
    // `-map_metadata -1` transcode it MUST NOT appear in the output.
    const proc = Bun.spawn(
      [
        ffmpegPath,
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=2:size=160x120:rate=10',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=2',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-c:a',
        'aac',
        '-pix_fmt',
        'yuv420p',
        '-metadata',
        'comment=STORAGE_FU_5_FU_B_CANARY',
        '-movflags',
        '+frag_keyframe+empty_moov',
        '-f',
        'mp4',
        'pipe:1',
      ],
      { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    );
    const bytes = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
    await proc.exited;
    return bytes;
  }

  test('probe + poster + transcode all produce real bytes (no 24-byte / 4-byte stub leak)', async () => {
    const source = await generateSourceMp4();
    expect(source.length).toBeGreaterThan(0);

    const proc = new FfmpegVideoProcessor();

    // 1. Probe returns honest data.
    const probe = await proc.probe({ bytes: source });
    expect(probe.durationSeconds).toBeGreaterThan(1.5);
    expect(probe.durationSeconds).toBeLessThan(3);
    expect(probe.width).toBe(160);
    expect(probe.height).toBe(120);
    expect(probe.videoCodec).toBe('h264');
    expect(probe.audioCodec).toBe('aac');

    // 2. Poster produces a real JPEG.
    const poster = await proc.renderPoster({
      bytes: source,
      profile: FAKE_PROFILE,
    });
    expect(poster.contentType).toBe('image/jpeg');
    expect(poster.bytes.length).toBeGreaterThan(1024);
    expect(poster.bytes[0]).toBe(0xff);
    expect(poster.bytes[1]).toBe(0xd8);

    // 3. Transcode produces a real fMP4.
    const transcode = await proc.renderTranscode({
      bytes: source,
      profile: FAKE_PROFILE,
    });
    expect(transcode.contentType).toBe('video/mp4');
    expect(transcode.bytes.length).toBeGreaterThan(1024);
    // First 8 bytes look like an MP4 box header (`size` then `ftyp`).
    // We don't assert exact bytes (different ffmpeg versions vary),
    // just that the 4 bytes at offset 4 are the `ftyp` ASCII.
    expect(transcode.bytes[4]).toBe(0x66); // 'f'
    expect(transcode.bytes[5]).toBe(0x74); // 't'
    expect(transcode.bytes[6]).toBe(0x79); // 'y'
    expect(transcode.bytes[7]).toBe(0x70); // 'p'

    // 4. The canary comment must NOT survive the transcode.
    // Search the entire output bytes for the canary substring as a
    // simple byte-level grep.
    const canary = new TextEncoder().encode('STORAGE_FU_5_FU_B_CANARY');
    const transcodeBuf = Buffer.from(transcode.bytes);
    expect(transcodeBuf.includes(Buffer.from(canary))).toBe(false);
  }, 60_000);
});
