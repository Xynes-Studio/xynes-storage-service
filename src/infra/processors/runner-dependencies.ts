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
 *     for `image_optimize`. Video / document still use the safe-fail
 *     production stubs that throw `UNSUPPORTED_FORMAT` until
 *     STORAGE-FU-5-FU-B (ffmpeg) and STORAGE-FU-5-FU-C (LibreOffice)
 *     land. This is a deliberate fail-safe: a hosted environment that
 *     flips `live` without the per-family adapter wired sees clean
 *     closed-set runner failures, not opaque crashes.
 *
 *     Sharp import failure (corrupted libvips binding, unsupported
 *     platform) falls back to `ProductionImageProcessorStub` with a
 *     single startup WARN — image jobs dead-letter cleanly instead of
 *     crashing the worker.
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
import { SharpImageProcessor } from './sharp-image-processor';

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
 * The WARN log fires EXACTLY ONCE per process at startup. Subsequent
 * fallbacks (e.g. if a transient `sharp` import succeeded but
 * construction throws on a later call) reuse the same flag.
 */
let sharpFallbackLogged = false;
function buildLiveImageProcessor(): ImageProcessor {
  try {
    return new SharpImageProcessor();
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
    options.video ??
    (mode === 'stub' ? new StubVideoProcessor() : new ProductionVideoProcessorStub());
  const document: DocumentProcessor =
    options.document ??
    (mode === 'stub' ? new StubDocumentProcessor() : new ProductionDocumentProcessorStub());
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
