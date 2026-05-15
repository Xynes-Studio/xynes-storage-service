/**
 * STORAGE-FU-5 — production processors (sharp / ffmpeg / libreoffice).
 *
 * **Status: scaffolded only.** These stubs throw a non-retryable
 * `UNSUPPORTED_FORMAT` `RunnerInputError` on every invocation.
 *
 * NOTE on surface-level behaviour: the STORAGE-8 runners wrap EVERY
 * processor throw inside an inner try/catch that remaps to
 * `RunnerExecutionError('PROCESSOR_FAILED', { retryable: true })`.
 * So the operator-facing failure looks like a retryable
 * `PROCESSOR_FAILED` — the worker retries up to `maxAttempts` (default
 * 3 per STORAGE-7), then dead-letters. The closed-set
 * `PROCESSOR_FAILED` code is the audit signal that points operators at
 * "production processor adapter is missing or broken". This is
 * deliberate — runners must not distinguish "format unsupported" from
 * "transient processor outage" at the call site (the STORAGE-8 design
 * decision keeps every processor call defensively wrapped).
 *
 * Replacing each stub with the real adapter (sharp/libvips bound,
 * ffmpeg static binary, libreoffice headless sidecar) is a follow-up
 * infra story per
 * `xynes/xynes-infra/docs/plans/2026-05-14-storage-register-handlers-and-drizzle-wiring.md`
 * §8 STORAGE-FU-5 acceptance criteria. The follow-up will:
 *   1. Add `sharp` (or equivalent) as a runtime dependency.
 *   2. Wire ffmpeg via `ffmpeg-static` + `fluent-ffmpeg` OR a sidecar
 *      container.
 *   3. Wire libreoffice via a headless `soffice` child process OR a
 *      sidecar.
 *   4. Install the binaries in the storage-service Dockerfile (or
 *      sidecar manifests) per the deployment posture chosen in plan
 *      §12 Q3.
 *
 * Until then, production deployments selecting `STORAGE_PROCESSOR_MODE=live`
 * with no real adapter wired see clean retryable `PROCESSOR_FAILED`
 * dead-letters for image/video/document jobs. The scan runner still
 * works (it depends on a `MalwareScanner` port, not a media processor),
 * so the parent object still flips to `ready` for uploads that have no
 * variants planned.
 *
 * SECURITY invariants:
 *   - These stubs do NOT decode input bytes. They cannot leak.
 *   - They throw a closed-set runner error code, NOT a raw library
 *     message.
 */
import { RunnerInputError } from '../../actions/handlers/processing/runners/errors';
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

function notWired(): never {
  // `UNSUPPORTED_FORMAT` is non-retryable — STORAGE-7 will dead-letter
  // the job after one attempt rather than retrying forever against a
  // processor that hasn't been wired yet.
  throw new RunnerInputError('UNSUPPORTED_FORMAT');
}

/**
 * Production image processor. Throws `UNSUPPORTED_FORMAT` until the
 * follow-up infra story wires sharp/libvips.
 */
export class ProductionImageProcessorStub implements ImageProcessor {
  async probe(_input: { bytes: Uint8Array }): Promise<ImageProbeResult> {
    void _input;
    return notWired();
  }
  async renderVariant(_input: {
    bytes: Uint8Array;
    spec: import('../../actions/handlers/processing/runners/profiles').ImageVariantSpec;
  }): Promise<ImageVariantRender> {
    void _input;
    return notWired();
  }
}

/**
 * Production video processor. Throws `UNSUPPORTED_FORMAT` until the
 * follow-up infra story wires ffmpeg.
 */
export class ProductionVideoProcessorStub implements VideoProcessor {
  async probe(_input: { bytes: Uint8Array }): Promise<VideoProbeResult> {
    void _input;
    return notWired();
  }
  async renderPoster(_input: {
    bytes: Uint8Array;
    profile: import('../../actions/handlers/processing/runners/profiles').VideoProfile;
  }): Promise<VideoPosterRender> {
    void _input;
    return notWired();
  }
  async renderTranscode(_input: {
    bytes: Uint8Array;
    profile: import('../../actions/handlers/processing/runners/profiles').VideoProfile;
  }): Promise<VideoTranscodeRender> {
    void _input;
    return notWired();
  }
}

/**
 * Production document processor. Throws `UNSUPPORTED_FORMAT` until the
 * follow-up infra story wires libreoffice headless.
 */
export class ProductionDocumentProcessorStub implements DocumentProcessor {
  async renderFirstPagePreview(_input: {
    bytes: Uint8Array;
    sourceContentType: string;
  }): Promise<DocumentPreviewRender> {
    void _input;
    return notWired();
  }
}
