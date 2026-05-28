/**
 * STORAGE-FU-5-FU-B — ffmpeg-backed `VideoProcessor`.
 *
 * Implements the STORAGE-8 `VideoProcessor` port using the
 * `ffmpeg-static` binary invoked via `Bun.spawn`. Replaces
 * `ProductionVideoProcessorStub` (which throws `UNSUPPORTED_FORMAT`)
 * in `STORAGE_PROCESSOR_MODE=live` deployments once the composition
 * root wires this class in.
 *
 * Closes **Bug 1 (video variants)** — video variants in
 * `STORAGE_PROCESSOR_MODE=live` now produce real re-encoded bytes
 * (poster JPEG > 1 KiB, H.264/AAC MP4 > 1 KiB) instead of the
 * 24-byte stub-mode `ftypisom` artefact or `PROCESSOR_FAILED` from
 * the production stub.
 *
 * ── Security invariants ──────────────────────────────────────────────────
 *
 *   1. **Metadata stripping is MANDATORY.** Every transcode / poster
 *      command carries `-map_metadata -1` so embedded GPS,
 *      author, encoder hints, and rotation side-data do NOT survive
 *      the re-encode. Asserted by re-probing the transcode output
 *      and checking that the source `comment` metadata field is gone.
 *
 *   2. **No filesystem temp files.** ffmpeg reads from `pipe:0`
 *      (stdin) and writes to `pipe:1` (stdout). The processor
 *      never reaches for `os.tmpdir()` so a crash mid-encode cannot
 *      leak partial bytes to disk.
 *
 *   3. **ffmpeg arguments are NEVER user-controlled.** The processor
 *      constructs the full argv from the closed-set `VideoProfile`
 *      + fixed flags. There is no path where a hostile filename
 *      reaches the shell, no `-i <user-string>` interpolation, no
 *      `eval`. We invoke `Bun.spawn` with an array (NOT a shell
 *      string), so even if a hostile string slipped into a numeric
 *      field at the type-system level, the OS would interpret it
 *      as a single argv token, not a shell metacharacter.
 *
 *   4. **Defense-in-depth hard cap re-validation.** STORAGE-8 runners
 *      pre-validate probe results against `MAX_VIDEO_DIMENSION` /
 *      `MAX_VIDEO_DURATION_SECONDS`. We re-validate INSIDE the
 *      processor too so a future direct caller (e.g. a probe
 *      followed by direct `renderTranscode` from a different code
 *      path) can't bypass it.
 *
 *   5. **Process timeout enforced.** A run-away ffmpeg invocation
 *      (corrupted input that drives libavcodec into an infinite
 *      loop, slow remote codec, etc.) is killed after
 *      `STORAGE_FFMPEG_TIMEOUT_MS` (default 5 minutes). The killed
 *      process surfaces as a retryable `PROCESSOR_FAILED` — the
 *      worker will retry up to `maxAttempts`, then dead-letter.
 *
 *   6. **Closed-set runner errors only.** ffmpeg stderr is NEVER
 *      surfaced. Library throws map to:
 *        - probe-time decode failure → `RunnerInputError(
 *          'UNSUPPORTED_FORMAT')` (non-retryable per STORAGE-8 —
 *          retrying a malformed input won't help).
 *        - probe-time over-cap dimensions / duration →
 *          `RunnerInputError('OVER_MAX_DIMENSIONS' | 'OVER_MAX_DURATION')`.
 *        - render-time encode failure →
 *          `RunnerExecutionError('PROCESSOR_FAILED', retryable: true)`.
 *      The STORAGE-8 video runners wrap these too, so this is
 *      belt-and-braces.
 *
 *   7. **Bytes copied into fresh `Uint8Array` on return.** Callers
 *      never observe the underlying `ArrayBuffer` that the Bun
 *      stdout reader owned.
 *
 * ── Codec posture (MVP) ──────────────────────────────────────────────────
 *
 *   - Video codec: H.264 (`libx264`, preset `medium`) — broadest
 *     browser + CDN compatibility.
 *   - Audio codec: AAC LC.
 *   - Container: fragmented MP4 (`-movflags +frag_keyframe+empty_moov`)
 *     so the muxer can write to a non-seekable `pipe:1` without
 *     rewriting the `moov` atom. Players + browsers handle fMP4
 *     transparently; CDNs cache the bytes byte-for-byte.
 *
 * AV1 / WebM / HLS / DASH / hardware-accelerated encoding (NVENC /
 * VideoToolbox) and multi-resolution ladders are deferred per
 * STORAGE-8 "out of scope".
 */
import {
  RunnerExecutionError,
  RunnerInputError,
} from '../../actions/handlers/processing/runners/errors';
import type {
  VideoPosterRender,
  VideoProbeResult,
  VideoProcessor,
  VideoTranscodeRender,
} from '../../actions/handlers/processing/runners/ports';
import {
  MAX_VIDEO_DIMENSION,
  MAX_VIDEO_DURATION_SECONDS,
  type VideoProfile,
} from '../../actions/handlers/processing/runners/profiles';

/**
 * Default process-level timeout. Five minutes is enough for a
 * 1-hour H.264 720p transcode against an `ultrafast`/`medium`
 * preset on a modern worker; longer-running jobs are an operational
 * signal that the cap should be raised.
 */
export const DEFAULT_FFMPEG_TIMEOUT_MS = 5 * 60 * 1000;

/** Closed-set ffmpeg argv builder modes. */
type FfmpegInvocationKind = 'probe' | 'poster' | 'transcode';

/** Result of spawning an ffmpeg invocation with stdin → stdout pipes. */
interface SpawnResult {
  /** Process exit code. `null` when the process was killed by timeout. */
  readonly exitCode: number | null;
  /** Bytes captured from `pipe:1`. Empty for probe invocations. */
  readonly stdout: Uint8Array;
  /** Bytes captured from `stderr`. Used to parse probe results. */
  readonly stderr: string;
  /** Whether the process was killed by the timeout enforcer. */
  readonly timedOut: boolean;
}

/**
 * Inject-able process spawner. Production wires this to
 * `Bun.spawn`; tests inject a deterministic stub.
 */
export interface FfmpegSpawner {
  run(input: {
    argv: readonly string[];
    stdin: Uint8Array;
    timeoutMs: number;
    kind: FfmpegInvocationKind;
  }): Promise<SpawnResult>;
}

/**
 * Optional dependency override. Production constructor uses the
 * default Bun-backed spawner + `ffmpeg-static` binary path.
 */
export interface FfmpegVideoProcessorDeps {
  /** Override spawner for tests. */
  readonly spawner?: FfmpegSpawner;
  /** Override ffmpeg binary path. Defaults to `ffmpeg-static`. */
  readonly ffmpegPath?: string;
  /** Override per-job timeout. Defaults to `DEFAULT_FFMPEG_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

/**
 * Resolve the ffmpeg-static binary path lazily via `createRequire`
 * so the import doesn't blow up at module load when the binary is
 * missing or the platform isn't supported by ffmpeg-static.
 *
 * `ffmpeg-static`'s `index.js` exports the binary path as a default
 * export; it returns `null` when the active platform/arch is not
 * one of darwin / freebsd / linux / win32 with the supported arch
 * tuple. We treat `null` as a hard fail at construction time so
 * `runner-dependencies.ts` can fall back to the production stub.
 */
function resolveDefaultFfmpegPath(): string {
  // Inlined require — see security invariant in runner-dependencies
  // around `createRequire` for sharp. Same posture here.
  // We import dynamically so the module isn't pulled in during stub
  // mode (which has no need for ffmpeg).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createRequire } = require('node:module') as typeof import('node:module');
  const requireFn = createRequire(import.meta.url);
  const mod = requireFn('ffmpeg-static') as { default?: string | null } | string | null;
  // The CJS export shape varies between bundlers: it can be either
  // a bare string (legacy require) or `{ default: string | null }`
  // (ESM interop). Both reach the same value.
  const path =
    typeof mod === 'string' ? mod : typeof mod?.default === 'string' ? mod.default : null;
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('FFMPEG_BINARY_UNAVAILABLE');
  }
  return path;
}

/**
 * Default Bun-backed spawner. Pipes `stdin` into the child and
 * captures `stdout` + `stderr` to memory. Enforces `timeoutMs` by
 * racing a `setTimeout` against `proc.exited`.
 */
export const defaultBunSpawner: FfmpegSpawner = {
  async run(input) {
    const proc = Bun.spawn([...input.argv], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {
        // Already exited — ignore.
      }
    }, input.timeoutMs);

    // Feed stdin then close it. `proc.stdin` is a writable stream
    // when `stdin: 'pipe'`. We write the bytes and end the stream
    // BEFORE awaiting stdout/stderr — ffmpeg won't emit any output
    // until it sees EOF on stdin.
    try {
      const stdin = proc.stdin as
        | { write: (chunk: Uint8Array) => void; end: () => Promise<unknown> | unknown }
        | null
        | undefined;
      if (stdin && input.stdin.length > 0) {
        stdin.write(input.stdin);
      }
      if (stdin) {
        await stdin.end();
      }
    } catch {
      // ffmpeg may close stdin early on malformed input (it gives up
      // after the demuxer probe fails). That's expected; the exit
      // code carries the failure signal.
    }

    const [stdoutBuf, stderrText, exitCode] = await Promise.all([
      proc.stdout
        ? new Response(proc.stdout).arrayBuffer().catch(() => new ArrayBuffer(0))
        : new ArrayBuffer(0),
      proc.stderr ? new Response(proc.stderr).text().catch(() => '') : '',
      proc.exited,
    ]);

    clearTimeout(timeoutHandle);

    return {
      exitCode: typeof exitCode === 'number' ? exitCode : null,
      stdout: new Uint8Array(stdoutBuf),
      stderr: stderrText,
      timedOut,
    };
  },
};

// ── stderr parser ─────────────────────────────────────────────────────────

/**
 * Parse the `ffmpeg -i pipe:0 -f null -` stderr block. ffmpeg prints
 * input metadata to stderr in a stable, line-oriented format. The
 * regular expressions below match the well-known shapes:
 *
 *   - `  Duration: HH:MM:SS.cc, ...`
 *   - `  Stream #0:0[...]: Video: <codec> [...], <pixfmt>(...), WIDTHxHEIGHT [SAR ...]`
 *   - `  Stream #0:1[...]: Audio: <codec> ...`
 *   - `      rotate          : 90`   (older builds)
 *   - `      displaymatrix: rotation of -90.00 degrees`   (newer)
 *
 * The parser is defensive: every field is optional, malformed lines
 * are skipped, and a buffer that yields no Video stream surfaces as
 * `UNSUPPORTED_FORMAT` at the caller.
 */
interface ParsedProbe {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  rotationDegrees: number | null;
}

const DURATION_RE = /Duration:\s*(\d+):(\d+):(\d+)(?:\.(\d+))?/;
const INPUT_RE = /Input #0,\s*([^,]+),/;
const VIDEO_STREAM_RE = /Stream\s+#\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?:\s*Video:\s*([^\s,]+)/;
const VIDEO_DIMENSIONS_RE = /(\d{2,5})x(\d{2,5})(?:\s|,|\[|$)/;
const AUDIO_STREAM_RE = /Stream\s+#\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?:\s*Audio:\s*([^\s,]+)/;
const ROTATE_RE = /rotate\s*:\s*(-?\d+)/;
const DISPLAYMATRIX_RE = /displaymatrix:\s*rotation\s+of\s+(-?\d+(?:\.\d+)?)/;

function parseFfmpegProbe(stderr: string): ParsedProbe {
  const result: ParsedProbe = {
    durationSeconds: null,
    width: null,
    height: null,
    container: null,
    videoCodec: null,
    audioCodec: null,
    rotationDegrees: null,
  };

  // Duration.
  const dm = stderr.match(DURATION_RE);
  if (dm) {
    const h = Number(dm[1]);
    const m = Number(dm[2]);
    const s = Number(dm[3]);
    const cs = dm[4] ? Number(`0.${dm[4]}`) : 0;
    if (Number.isFinite(h) && Number.isFinite(m) && Number.isFinite(s)) {
      result.durationSeconds = h * 3600 + m * 60 + s + cs;
    }
  }

  // Container.
  const im = stderr.match(INPUT_RE);
  if (im) {
    // ffmpeg prints joint container labels like
    // `mov,mp4,m4a,3gp,3g2,mj2` — the first token is enough.
    result.container = im[1].split(',')[0].trim() || null;
  }

  // First video stream — codec + dimensions.
  // We scan lines so we can match dimensions on the SAME line as the
  // codec (rather than the first WxH-looking substring anywhere in
  // stderr, which can come from Output blocks).
  const lines = stderr.split('\n');
  for (const line of lines) {
    if (result.videoCodec && result.width !== null) break;
    const vm = line.match(VIDEO_STREAM_RE);
    if (vm) {
      result.videoCodec = vm[1].toLowerCase();
      const dim = line.match(VIDEO_DIMENSIONS_RE);
      if (dim) {
        const w = Number(dim[1]);
        const h = Number(dim[2]);
        if (Number.isFinite(w) && Number.isFinite(h)) {
          result.width = w;
          result.height = h;
        }
      }
    }
  }

  // First audio stream.
  for (const line of lines) {
    const am = line.match(AUDIO_STREAM_RE);
    if (am) {
      result.audioCodec = am[1].toLowerCase();
      break;
    }
  }

  // Rotation. Prefer `displaymatrix` (newer ffmpeg) over `rotate:`
  // (legacy metadata). If we see the displaymatrix value first, lock
  // it in.
  const dmx = stderr.match(DISPLAYMATRIX_RE);
  if (dmx) {
    const deg = Number(dmx[1]);
    if (Number.isFinite(deg)) {
      // displaymatrix prints values like `-90.00` — we want the
      // integer-truncated degree.
      result.rotationDegrees = Math.round(deg);
    }
  } else {
    const rm = stderr.match(ROTATE_RE);
    if (rm) {
      const deg = Number(rm[1]);
      if (Number.isFinite(deg)) {
        result.rotationDegrees = deg;
      }
    }
  }

  return result;
}

// ── argv builders ─────────────────────────────────────────────────────────

function buildProbeArgv(ffmpegPath: string): readonly string[] {
  return [
    ffmpegPath,
    '-hide_banner',
    '-i',
    'pipe:0',
    // `-f null -` decodes the input as far as the demuxer can read
    // it (one pass) and produces no output. The bytes we want live
    // in stderr.
    '-f',
    'null',
    '-',
  ];
}

function buildPosterArgv(ffmpegPath: string, profile: VideoProfile): readonly string[] {
  // Seek BEFORE input so ffmpeg uses fast seek; but for pipes we
  // can't do `-ss` before `-i pipe:0` (no seek table). So we seek
  // AFTER input and pay the linear-scan cost — acceptable for the
  // poster frame.
  const scaleFilter = `scale='min(${profile.posterMaxWidth},iw)':'min(${profile.posterMaxHeight},ih)':force_original_aspect_ratio=decrease`;
  return [
    ffmpegPath,
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    'pipe:0',
    // Take a frame at ~1.0s into the clip (or the first frame if the
    // clip is shorter). `-ss` AFTER `-i` does a slow seek but we're
    // pulling exactly one frame so the cost is bounded.
    '-ss',
    '1.0',
    '-frames:v',
    '1',
    '-vf',
    scaleFilter,
    // Strip metadata (security invariant #1).
    '-map_metadata',
    '-1',
    '-f',
    'mjpeg',
    'pipe:1',
  ];
}

function buildTranscodeArgv(ffmpegPath: string, profile: VideoProfile): readonly string[] {
  const scaleFilter = `scale='min(${profile.maxWidth},iw)':'min(${profile.maxHeight},ih)':force_original_aspect_ratio=decrease`;
  return [
    ffmpegPath,
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    'pipe:0',
    // Video: H.264 with libx264 preset `medium`. Bitrate driven by
    // the profile.
    '-vf',
    scaleFilter,
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-b:v',
    `${profile.targetBitrateKbps}k`,
    '-pix_fmt',
    'yuv420p',
    // Audio: AAC LC at 128 kbps (a reasonable fixed default — we
    // don't have an `audioBitrateKbps` field on the profile yet).
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    // Strip metadata (security invariant #1).
    '-map_metadata',
    '-1',
    // Fragmented MP4 so the muxer can write to a pipe.
    '-movflags',
    '+frag_keyframe+empty_moov',
    '-f',
    'mp4',
    'pipe:1',
  ];
}

// ── helpers ───────────────────────────────────────────────────────────────

function isOverDimensionCap(probe: ParsedProbe): boolean {
  return (
    (typeof probe.width === 'number' && probe.width > MAX_VIDEO_DIMENSION) ||
    (typeof probe.height === 'number' && probe.height > MAX_VIDEO_DIMENSION)
  );
}

function isOverDurationCap(probe: ParsedProbe): boolean {
  return (
    typeof probe.durationSeconds === 'number' && probe.durationSeconds > MAX_VIDEO_DURATION_SECONDS
  );
}

// ── processor ─────────────────────────────────────────────────────────────

/**
 * Production video processor backed by ffmpeg-static.
 *
 * Stateless — safe to instantiate once and share across the worker's
 * processing loop. The instance carries no per-call state; every
 * method spawns a fresh ffmpeg invocation.
 */
export class FfmpegVideoProcessor implements VideoProcessor {
  private readonly ffmpegPath: string;
  private readonly spawner: FfmpegSpawner;
  private readonly timeoutMs: number;

  constructor(deps: FfmpegVideoProcessorDeps = {}) {
    this.ffmpegPath = deps.ffmpegPath ?? resolveDefaultFfmpegPath();
    this.spawner = deps.spawner ?? defaultBunSpawner;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_FFMPEG_TIMEOUT_MS;
  }

  async probe(input: { bytes: Uint8Array }): Promise<VideoProbeResult> {
    let result: SpawnResult;
    try {
      result = await this.spawner.run({
        argv: buildProbeArgv(this.ffmpegPath),
        stdin: input.bytes,
        timeoutMs: this.timeoutMs,
        kind: 'probe',
      });
    } catch {
      throw new RunnerExecutionError('PROCESSOR_FAILED', { retryable: true });
    }

    if (result.timedOut) {
      throw new RunnerExecutionError('PROCESSOR_FAILED', { retryable: true });
    }

    const parsed = parseFfmpegProbe(result.stderr);

    // No video stream → input is not video.
    if (!parsed.videoCodec || parsed.width === null || parsed.height === null) {
      throw new RunnerInputError('UNSUPPORTED_FORMAT');
    }
    if (parsed.width <= 0 || parsed.height <= 0) {
      throw new RunnerInputError('UNSUPPORTED_FORMAT');
    }
    // Duration is required for downstream poster + transcode planning.
    if (parsed.durationSeconds === null || !Number.isFinite(parsed.durationSeconds)) {
      throw new RunnerInputError('UNSUPPORTED_FORMAT');
    }

    // Defense-in-depth hard cap re-validation. The STORAGE-8 runner
    // ALSO checks; we do it here so a future direct caller can't
    // bypass.
    if (isOverDimensionCap(parsed)) {
      throw new RunnerInputError('OVER_MAX_DIMENSIONS');
    }
    if (isOverDurationCap(parsed)) {
      throw new RunnerInputError('OVER_MAX_DURATION');
    }

    return {
      durationSeconds: parsed.durationSeconds,
      width: parsed.width,
      height: parsed.height,
      container: parsed.container ?? 'unknown',
      videoCodec: parsed.videoCodec,
      audioCodec: parsed.audioCodec,
      rotationDegrees: parsed.rotationDegrees,
    };
  }

  async renderPoster(input: {
    bytes: Uint8Array;
    profile: VideoProfile;
  }): Promise<VideoPosterRender> {
    let result: SpawnResult;
    try {
      result = await this.spawner.run({
        argv: buildPosterArgv(this.ffmpegPath, input.profile),
        stdin: input.bytes,
        timeoutMs: this.timeoutMs,
        kind: 'poster',
      });
    } catch {
      throw new RunnerExecutionError('PROCESSOR_FAILED', { retryable: true });
    }

    if (result.timedOut || result.exitCode !== 0 || result.stdout.length === 0) {
      throw new RunnerExecutionError('PROCESSOR_FAILED', { retryable: true });
    }

    // We don't have to (and don't want to) re-decode the JPEG just
    // to read its dimensions. `force_original_aspect_ratio=decrease`
    // honours both caps; the actual width/height of the emitted
    // frame is bounded by the profile's poster caps. Reporting the
    // cap is an honest upper bound for the variant record.
    return {
      // Copy into a fresh Uint8Array so the caller never observes
      // the underlying ArrayBuffer that the Bun stdout reader owned
      // (security invariant #7).
      bytes: new Uint8Array(result.stdout),
      width: input.profile.posterMaxWidth,
      height: input.profile.posterMaxHeight,
      contentType: 'image/jpeg',
    };
  }

  async renderTranscode(input: {
    bytes: Uint8Array;
    profile: VideoProfile;
  }): Promise<VideoTranscodeRender> {
    let result: SpawnResult;
    try {
      result = await this.spawner.run({
        argv: buildTranscodeArgv(this.ffmpegPath, input.profile),
        stdin: input.bytes,
        timeoutMs: this.timeoutMs,
        kind: 'transcode',
      });
    } catch {
      throw new RunnerExecutionError('PROCESSOR_FAILED', { retryable: true });
    }

    if (result.timedOut || result.exitCode !== 0 || result.stdout.length === 0) {
      throw new RunnerExecutionError('PROCESSOR_FAILED', { retryable: true });
    }

    // We DON'T re-probe the transcoded output for duration — that
    // would double the cost of every transcode. The caller can
    // re-probe if it needs the canonical re-encoded duration. We
    // report the profile cap as the dimension upper bound (same
    // posture as the poster path).
    return {
      bytes: new Uint8Array(result.stdout),
      width: input.profile.maxWidth,
      height: input.profile.maxHeight,
      // Duration is best-effort 0 — the caller (`video_transcode`
      // runner) does not currently consult this field on the
      // returned render. Stub-mode reports 12 as a placeholder; we
      // report 0 so downstream code that DOES read this gets an
      // honest "unknown" signal rather than a fabricated number.
      // Future enhancement: re-probe stdout to surface the canonical
      // transcoded duration.
      durationSeconds: 0,
      contentType: 'video/mp4',
    };
  }
}

// ── test-only seam ────────────────────────────────────────────────────────

/**
 * Exposed for `ffmpeg-video-processor.test.ts` so the stderr parser
 * can be exercised independently without spawning ffmpeg. Production
 * callers MUST NOT depend on this — it's an internal helper.
 */
export const __forTesting__ = {
  parseFfmpegProbe,
  buildProbeArgv,
  buildPosterArgv,
  buildTranscodeArgv,
  resolveDefaultFfmpegPath,
};
