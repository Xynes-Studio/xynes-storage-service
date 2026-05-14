/**
 * STORAGE-8 — closed-set runner error codes.
 *
 * Runners NEVER surface raw provider error messages, raw library
 * messages, or any path / credential / signed URL. Failures translate
 * into a closed, fixed-format error code so:
 *   1. The worker's redaction posture is preserved (worker.ts uses
 *      `RUNNER_FAILED` / `RUNNER_THREW` / `RUNNER_MISSING` itself).
 *   2. Downstream telemetry, logs, and `PublicProcessingJob.errorCode`
 *      stay deterministic.
 *   3. Operators can map error codes to runbooks without reading
 *      stack traces.
 *
 * Closed-set members:
 *   - `PROFILE_GUARD_REJECTED` — input violated a named profile guard
 *     (e.g. dimension cap, duration cap). Non-retryable.
 *   - `OVER_MAX_BYTES`         — input byte size exceeds the per-family
 *     hard cap (independent of any profile). Non-retryable.
 *   - `OVER_MAX_DIMENSIONS`    — image / video dimensions exceed the
 *     per-family hard cap. Non-retryable.
 *   - `OVER_MAX_DURATION`      — video duration exceeds the per-family
 *     hard cap. Non-retryable.
 *   - `UNSUPPORTED_FORMAT`     — the runner does not know how to
 *     process this content type. Non-retryable.
 *   - `MALWARE_DETECTED`       — scanner returned `infected`.
 *     Non-retryable.
 *   - `SCANNER_INCONCLUSIVE`   — scanner returned `unknown` (e.g.
 *     transient backend error). Retryable.
 *   - `PROCESSOR_FAILED`       — the underlying media processor returned
 *     a generic failure. Retryable.
 *
 * `RunnerInputError` is for non-retryable validation failures (the
 * inputs make the job unprocessable as-is). `RunnerExecutionError` is
 * for processor-side failures (the runner can be retried).
 */

export const RUNNER_ERROR_CODES = [
  'PROFILE_GUARD_REJECTED',
  'OVER_MAX_BYTES',
  'OVER_MAX_DIMENSIONS',
  'OVER_MAX_DURATION',
  'UNSUPPORTED_FORMAT',
  'MALWARE_DETECTED',
  'SCANNER_INCONCLUSIVE',
  'PROCESSOR_FAILED',
] as const;

export type RunnerErrorCode = (typeof RUNNER_ERROR_CODES)[number];

/** Non-retryable input/profile rejection. */
export class RunnerInputError extends Error {
  override readonly name = 'RunnerInputError';
  readonly code: RunnerErrorCode;
  readonly retryable = false;
  constructor(code: RunnerErrorCode) {
    super(code);
    this.code = code;
  }
}

/** Retryable processor-side failure. */
export class RunnerExecutionError extends Error {
  override readonly name = 'RunnerExecutionError';
  readonly code: RunnerErrorCode;
  readonly retryable: boolean;
  constructor(code: RunnerErrorCode, opts?: { retryable?: boolean }) {
    super(code);
    this.code = code;
    this.retryable = opts?.retryable ?? true;
  }
}

/** Type guard for either runner error. */
export function isRunnerError(value: unknown): value is RunnerInputError | RunnerExecutionError {
  return value instanceof RunnerInputError || value instanceof RunnerExecutionError;
}
