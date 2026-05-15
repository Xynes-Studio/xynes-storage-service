/**
 * STORAGE-8 — scan / validation runner.
 *
 * Replaces the STORAGE-7 no-op stub for `scan_validation`. The runner:
 *   1. Reads the object bytes from the provider (via the narrow
 *      `ProviderObjectIO` port).
 *   2. Enforces the per-family hard byte cap (independent of any
 *      profile). Over-cap surfaces as a non-retryable `OVER_MAX_BYTES`.
 *   3. Invokes the injected malware scanner. `clean` -> success;
 *      `infected` -> non-retryable `MALWARE_DETECTED`; `unknown` ->
 *      retryable `SCANNER_INCONCLUSIVE` (so a transient scanner outage
 *      doesn't dead-letter every upload).
 *
 * The runner NEVER:
 *   - logs the bytes, the signature name, the path, or the signed URL.
 *   - falls through to "best-effort clean" — an `unknown` verdict is
 *     retried, not coerced.
 *
 * Required job — failures flip the parent object to `failed` per
 * STORAGE-7's aggregator.
 */
import type { JobRunner, JobRunResult } from '../types';
import { classifyContentType } from '../../objects/schemas';
import { RunnerExecutionError, RunnerInputError } from './errors';
import { MAX_DOCUMENT_BYTES, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES } from './profiles';
import type { MalwareScanner, ProviderObjectIO } from './ports';
import { runRunnerWithErrorMapping } from './runner-utils';

export interface ScanValidationRunnerDependencies {
  readonly providerIO: ProviderObjectIO;
  readonly scanner: MalwareScanner;
}

function hardCapForContentType(contentType: string): number | null {
  const family = classifyContentType(contentType);
  if (family === 'image') return MAX_IMAGE_BYTES;
  if (family === 'video') return MAX_VIDEO_BYTES;
  if (family === 'document') return MAX_DOCUMENT_BYTES;
  // audio / archive / text / other -> no profile-driven cap; rely on
  // the platform-wide upload-time cap enforced by STORAGE-5.
  return null;
}

export function createScanValidationRunner(deps: ScanValidationRunnerDependencies): JobRunner {
  return async ({ object }): Promise<JobRunResult | void> => {
    return runRunnerWithErrorMapping(async () => {
      // 1) Hard byte cap.
      const cap = hardCapForContentType(object.contentType);
      if (cap !== null && object.byteSize > cap) {
        throw new RunnerInputError('OVER_MAX_BYTES');
      }

      // 2) Pull bytes for the scanner. Provider failures are retryable.
      let bytes: Uint8Array;
      try {
        bytes = await deps.providerIO.readObject({
          objectKey: object.providerObjectKey,
          workspaceId: object.workspaceId,
          providerId: object.providerId,
        });
      } catch {
        throw new RunnerExecutionError('PROCESSOR_FAILED', { retryable: true });
      }

      // 3) Scan.
      const result = await deps.scanner.scan({ bytes });
      switch (result.verdict) {
        case 'clean':
          return {};
        case 'infected':
          throw new RunnerInputError('MALWARE_DETECTED');
        case 'unknown':
          throw new RunnerExecutionError('SCANNER_INCONCLUSIVE', { retryable: true });
      }
    });
  };
}
