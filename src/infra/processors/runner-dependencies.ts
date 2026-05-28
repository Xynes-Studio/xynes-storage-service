/**
 * STORAGE-FU-5 — processor mode selection + runner-registry assembly.
 *
 * Two modes:
 *
 *   - `stub` (default for `NODE_ENV !== 'production'`)
 *     Uses the pass-through stub processors. Local dev + integration
 *     smoke can exercise the full upload → enqueue → run pipeline
 *     without sharp / ffmpeg / libreoffice / clamav installed.
 *
 *   - `live` (default for `NODE_ENV === 'production'`)
 *     STORAGE-FU-5-FU-A: wires `SharpImageProcessor` (sharp/libvips)
 *     for `image_optimize`.
 *     STORAGE-FU-5-FU-B: wires `FfmpegVideoProcessor` (ffmpeg-static)
 *     for `video_probe` / `video_thumbnail` / `video_transcode`.
 *     Document still uses the safe-fail production stub that throws
 *     `UNSUPPORTED_FORMAT` until STORAGE-FU-5-FU-C (LibreOffice)
 *     lands. This is a deliberate fail-safe: a hosted environment
 *     that flips `live` without the per-family adapter wired sees
 *     clean closed-set runner failures, not opaque crashes.
 *
 *     Sharp or ffmpeg-static import failure (corrupted binding /
 *     binary, unsupported platform) falls back to the production
 *     stubs with a single startup WARN per family — image / video
 *     jobs dead-letter cleanly instead of crashing the worker.
 *
 * Override via `STORAGE_PROCESSOR_MODE` env. `live` requires every
 * downstream binary to be installed; treat that switch as a deploy
 * gate. STORAGE-9 §6 records the rollout posture.
 *
 * Scanner posture:
 *
 *   - Stub mode → `noopMalwareScanner` (verdict always `clean`).
 *   - Live mode → also `noopMalwareScanner` for now; wiring clamav (or
 *     a clamav-rest sidecar) is STORAGE-FU-5-FU-D.
 *
 * The composition root constructs ONE `createRunnerDependencies`
 * result and passes the registry to `ProcessingWorker`. The scan
 * runner is always wired (it depends only on the scanner port + IO),
 * so the parent object's `scan_validation` job always has a runner.
 */
import { createRunnerRegistry } from '../../actions/handlers/processing/runners/registry';
import { noopMalwareScanner } from '../../actions/handlers/processing/runners/ports';
import type {
  DocumentProcessor,
  ImageProcessor,
  MalwareScanner,
  ProviderObjectIO,
  StorageVariantWriter,
  VideoProcessor,
} from '../../actions/handlers/processing/runners/ports';
import type { JobRunner, ProcessingJobType } from '../../actions/handlers/processing/types';
import { StubDocumentProcessor, StubImageProcessor, StubVideoProcessor } from './stub-processors';
import {
  ProductionDocumentProcessorStub,
  ProductionImageProcessorStub,
  ProductionVideoProcessorStub,
} from './production-processors';
// Type-only imports — does NOT pull in `sharp` or `ffmpeg-static` at
// module load. The runtime values are lazy-loaded inside
// `buildLiveImageProcessor()` / `buildLiveVideoProcessor()` via
// `createRequire` so stub mode boots even when the native binaries
// are missing or corrupted (STORAGE-FU-5-FU-A / FU-B safe-fail
// invariant).
import type { SharpImageProcessor as SharpImageProcessorType } from './sharp-image-processor';
import type {
  FfmpegVideoProcessor as FfmpegVideoProcessorType,
  FfmpegVideoProcessorDeps,
} from './ffmpeg-video-processor';
import type {
  LibreOfficeDocumentProcessor as LibreOfficeDocumentProcessorType,
  LibreOfficeDocumentProcessorDeps,
} from './libreoffice-document-processor';
import { createRequire } from 'node:module';

export const PROCESSOR_MODES = ['stub', 'live'] as const;
export type ProcessorMode = (typeof PROCESSOR_MODES)[number];

export function isProcessorMode(value: unknown): value is ProcessorMode {
  return typeof value === 'string' && (PROCESSOR_MODES as readonly string[]).includes(value);
}

/**
 * Resolve the active mode from the env. Defaults to `stub` outside
 * production for laptop-runnable dev; defaults to `live` inside
 * production so a misconfigured deploy that drops the env var doesn't
 * silently keep using stub bytes against a real bucket.
 */
export function resolveProcessorMode(env: NodeJS.ProcessEnv): ProcessorMode {
  const raw = env.STORAGE_PROCESSOR_MODE;
  if (isProcessorMode(raw)) return raw;
  return env.NODE_ENV === 'production' ? 'live' : 'stub';
}

export interface RunnerDependenciesOptions {
  readonly providerIO: ProviderObjectIO;
  readonly variants: StorageVariantWriter;
  /** Optional malware scanner override. Defaults to `noopMalwareScanner`. */
  readonly scanner?: MalwareScanner;
  /** Optional image processor override. */
  readonly image?: ImageProcessor;
  /** Optional video processor override. */
  readonly video?: VideoProcessor;
  /** Optional document processor override. */
  readonly document?: DocumentProcessor;
  /** Optional env reader. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Optional explicit mode override. Bypasses env resolution. */
  readonly mode?: ProcessorMode;
}

export interface ResolvedRunnerDependencies {
  readonly mode: ProcessorMode;
  readonly registry: Readonly<Partial<Record<ProcessingJobType, JobRunner>>>;
}

/**
 * Build the production image processor.
 *
 * STORAGE-FU-5-FU-A: live mode wires `SharpImageProcessor` (sharp /
 * libvips). If the sharp binary fails to load (corrupted install,
 * unsupported platform binding, etc.) we fall back to the safe-fail
 * `ProductionImageProcessorStub` so the worker still boots — every
 * `image_optimize` job dead-letters with `PROCESSOR_FAILED` instead of
 * crashing the whole process.
 *
 * **Lazy-load contract.** `sharp-image-processor.ts` carries module-
 * level side effects (`import sharp from 'sharp'` + `sharp.cache(false)`).
 * If we imported the class statically, the require chain would
 * evaluate at module load and throw BEFORE this function's try/catch
 * runs — taking the whole process down. Even worse, stub mode would
 * fail to boot even though it never needs sharp at all. We use
 * `createRequire` here to defer evaluation: the require only fires
 * when live mode is actually selected, and any failure (missing
 * binding, broken libvips link, ESM/CJS interop hiccup) is caught.
 *
 * The WARN log fires EXACTLY ONCE per process at startup. Subsequent
 * fallbacks (e.g. if a transient `sharp` import succeeded but
 * construction throws on a later call) reuse the same flag.
 *
 * **Test seam.** The `loader` parameter lets tests inject a failure
 * factory without globally mocking the `sharp` module — Bun's
 * `mock.module` is process-wide and would break neighbouring test
 * files. Production callers never pass `loader`.
 */
let sharpFallbackLogged = false;
type SharpProcessorCtor = new () => SharpImageProcessorType;
function defaultSharpLoader(): SharpProcessorCtor {
  const requireFn = createRequire(import.meta.url);
  const mod = requireFn('./sharp-image-processor') as {
    SharpImageProcessor: SharpProcessorCtor;
  };
  return mod.SharpImageProcessor;
}
function buildLiveImageProcessor(
  loader: () => SharpProcessorCtor = defaultSharpLoader,
): ImageProcessor {
  try {
    // Lazy-resolve the SharpImageProcessor module ONLY in live mode.
    // Stub mode never reaches this branch, so a clean-laptop install
    // without libvips can still boot the service in stub mode.
    const Ctor = loader();
    return new Ctor();
  } catch (err) {
    if (!sharpFallbackLogged) {
      sharpFallbackLogged = true;
      // Single WARN at startup; never re-emit per-call. Message
      // carries NO library hint — STORAGE-9 redaction posture.
      // eslint-disable-next-line no-console
      console.warn(
        '[runner-dependencies] sharp unavailable; image_optimize will dead-letter with PROCESSOR_FAILED until adapter is wired',
      );
      void err;
    }
    return new ProductionImageProcessorStub();
  }
}

/**
 * Build the production video processor.
 *
 * STORAGE-FU-5-FU-B: live mode wires `FfmpegVideoProcessor`
 * (`ffmpeg-static` invoked via `Bun.spawn`). Same lazy-load contract
 * as `buildLiveImageProcessor` — the require fires only when live
 * mode is actually selected, and a failure (missing binary, ESM/CJS
 * interop hiccup, unsupported platform/arch in ffmpeg-static) falls
 * back to `ProductionVideoProcessorStub` with a single startup WARN
 * so every video_* job dead-letters with `PROCESSOR_FAILED` instead
 * of crashing the worker.
 *
 * **Env contract.** The optional `STORAGE_FFMPEG_TIMEOUT_MS` env var
 * tunes the per-invocation timeout. Default 5 minutes (per the
 * deployment-posture doc).
 *
 * **Test seam.** Mirrors the sharp pattern: a `loader` param injects
 * a failure factory without process-wide module mocking; a `deps`
 * param lets tests pass a deterministic spawner.
 */
let ffmpegFallbackLogged = false;
type FfmpegProcessorCtor = new (deps?: FfmpegVideoProcessorDeps) => FfmpegVideoProcessorType;
function defaultFfmpegLoader(): FfmpegProcessorCtor {
  const requireFn = createRequire(import.meta.url);
  const mod = requireFn('./ffmpeg-video-processor') as {
    FfmpegVideoProcessor: FfmpegProcessorCtor;
  };
  return mod.FfmpegVideoProcessor;
}
function resolveFfmpegTimeoutMs(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.STORAGE_FFMPEG_TIMEOUT_MS;
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    return undefined;
  }
  return parsed;
}
function buildLiveVideoProcessor(
  env: NodeJS.ProcessEnv,
  loader: () => FfmpegProcessorCtor = defaultFfmpegLoader,
): VideoProcessor {
  try {
    const Ctor = loader();
    const timeoutMs = resolveFfmpegTimeoutMs(env);
    return new Ctor(timeoutMs !== undefined ? { timeoutMs } : undefined);
  } catch (err) {
    if (!ffmpegFallbackLogged) {
      ffmpegFallbackLogged = true;
      // Single WARN at startup; never re-emit per-call. Message
      // carries NO library hint — STORAGE-9 redaction posture.
      // eslint-disable-next-line no-console
      console.warn(
        '[runner-dependencies] ffmpeg unavailable; video_* runners will dead-letter with PROCESSOR_FAILED until adapter is wired',
      );
      void err;
    }
    return new ProductionVideoProcessorStub();
  }
}

/**
 * Build the production document processor.
 *
 * STORAGE-FU-5-FU-C: live mode wires `LibreOfficeDocumentProcessor`
 * (HTTP client → libreoffice-sidecar pod-local sidecar). Same
 * lazy-load contract as `buildLiveImageProcessor` / `buildLiveVideoProcessor`
 * — the require fires only when live mode is actually selected, and
 * a failure (missing module, ESM/CJS interop hiccup) falls back to
 * `ProductionDocumentProcessorStub` with a single startup WARN so
 * every `document_preview` job dead-letters with `PROCESSOR_FAILED`
 * instead of crashing the worker.
 *
 * **Env contract.** Required: `LIBREOFFICE_SERVICE_URL` — the
 * pod-local URL of the libreoffice-sidecar shim (default
 * `http://libreoffice-sidecar:8100`). UNSET / blank → safe-fail to
 * `ProductionDocumentProcessorStub` with a single startup WARN, per
 * FU-E §4 "Tier-2 processors fall back to the safe-fail production
 * stub when the env var is unset". Optional:
 * `STORAGE_SOFFICE_TIMEOUT_MS` — per-job timeout in ms; default
 * `60000` (60 s).
 *
 * **Why URL-unset is safe-fail (not throw).** A misconfigured live
 * deploy that drops `LIBREOFFICE_SERVICE_URL` should NOT crash the
 * whole worker. The image + video + scan runners still work; only
 * `document_preview` jobs degrade to clean `PROCESSOR_FAILED`
 * dead-letter envelopes. STORAGE-7 retries up to `maxAttempts` and
 * dead-letters — exactly the posture FU-E §4 commits to.
 *
 * **Test seam.** Mirrors the sharp / ffmpeg pattern: a `loader` param
 * injects a failure factory; a `deps` param lets tests pass a
 * deterministic sidecar client.
 */
let libreofficeFallbackLogged = false;
type LibreOfficeProcessorCtor = new (
  deps: LibreOfficeDocumentProcessorDeps,
) => LibreOfficeDocumentProcessorType;
function defaultLibreOfficeLoader(): LibreOfficeProcessorCtor {
  const requireFn = createRequire(import.meta.url);
  const mod = requireFn('./libreoffice-document-processor') as {
    LibreOfficeDocumentProcessor: LibreOfficeProcessorCtor;
  };
  return mod.LibreOfficeDocumentProcessor;
}
function resolveSofficeTimeoutMs(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.STORAGE_SOFFICE_TIMEOUT_MS;
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    return undefined;
  }
  return parsed;
}
function resolveLibreOfficeServiceUrl(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.LIBREOFFICE_SERVICE_URL;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed;
}
function warnLibreOfficeFallback(reason: 'url-missing' | 'ctor-failed'): void {
  if (libreofficeFallbackLogged) return;
  libreofficeFallbackLogged = true;
  // Single WARN at startup; never re-emit per-call. Message
  // carries NO library hint and NO URL — STORAGE-9 redaction
  // posture. The `reason` tag is the closed-set audit hook so
  // operators can grep for `url-missing` vs `ctor-failed`.
  // eslint-disable-next-line no-console
  console.warn(
    `[runner-dependencies] libreoffice unavailable (${reason}); document_preview will dead-letter with PROCESSOR_FAILED until adapter is wired`,
  );
}
function buildLiveDocumentProcessor(
  env: NodeJS.ProcessEnv,
  loader: () => LibreOfficeProcessorCtor = defaultLibreOfficeLoader,
): DocumentProcessor {
  const serviceUrl = resolveLibreOfficeServiceUrl(env);
  if (serviceUrl === undefined) {
    warnLibreOfficeFallback('url-missing');
    return new ProductionDocumentProcessorStub();
  }
  try {
    const Ctor = loader();
    const timeoutMs = resolveSofficeTimeoutMs(env);
    return new Ctor({
      serviceUrl,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  } catch (err) {
    warnLibreOfficeFallback('ctor-failed');
    void err;
    return new ProductionDocumentProcessorStub();
  }
}

/**
 * Test-only seam for STORAGE-FU-5-FU-A / FU-B / FU-C fallback
 * regression tests.
 *
 * Exported under a `__forTesting__` prefix so the linter / reader can
 * spot misuse — production callers MUST NOT depend on this. The seam
 * lets tests:
 *   1. Inject a custom sharp / ffmpeg / libreoffice loader that throws
 *      (simulating a missing native binding or sidecar resolution
 *      failure) WITHOUT calling Bun's `mock.module`, which is
 *      process-wide and pollutes neighbouring test files.
 *   2. Reset the per-family fallback latch between tests so the
 *      single-WARN invariant can be asserted deterministically.
 */
export const __forTesting__ = {
  buildLiveImageProcessor,
  buildLiveVideoProcessor,
  buildLiveDocumentProcessor,
  resolveFfmpegTimeoutMs,
  resolveSofficeTimeoutMs,
  resolveLibreOfficeServiceUrl,
  resetSharpFallbackLogged(): void {
    sharpFallbackLogged = false;
  },
  resetFfmpegFallbackLogged(): void {
    ffmpegFallbackLogged = false;
  },
  resetLibreOfficeFallbackLogged(): void {
    libreofficeFallbackLogged = false;
  },
};

/**
 * Assemble the runner registry the `ProcessingWorker` consumes. The
 * composition root calls this once and passes `registry` to
 * `runners`.
 */
export function createRunnerDependencies(
  options: RunnerDependenciesOptions,
): ResolvedRunnerDependencies {
  const env = options.env ?? process.env;
  const mode = options.mode ?? resolveProcessorMode(env);

  const image: ImageProcessor =
    options.image ?? (mode === 'stub' ? new StubImageProcessor() : buildLiveImageProcessor());
  const video: VideoProcessor =
    options.video ?? (mode === 'stub' ? new StubVideoProcessor() : buildLiveVideoProcessor(env));
  const document: DocumentProcessor =
    options.document ??
    (mode === 'stub' ? new StubDocumentProcessor() : buildLiveDocumentProcessor(env));
  const scanner: MalwareScanner = options.scanner ?? noopMalwareScanner;

  const registry = createRunnerRegistry({
    providerIO: options.providerIO,
    variants: options.variants,
    scanner,
    image,
    video,
    document,
  });

  return { mode, registry };
}
