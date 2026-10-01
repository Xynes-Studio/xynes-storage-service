/**
 * STORAGE-8 — scan / validation runner.
 *
 * Replaces the STORAGE-7 no-op stub for `scan_validation`. The runner:
 *   1. Validates stored size against the per-family/global hard cap.
 *   2. Reads bounded bytes via `ProviderObjectIO` and reconciles their
 *      actual length before scanning. Size failures are non-retryable.
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
import { MAX_SCANNER_INPUT_BYTES } from '../../objects/byte-size-policy';
import { readObjectForProcessing } from './read-object';
import type { JobRunner, JobRunResult } from '../types';
import { RunnerExecutionError, RunnerInputError } from './errors';
import type { MalwareScanner, ProviderObjectIO } from './ports';
import { runRunnerWithErrorMapping } from './runner-utils';

export interface ScanValidationRunnerDependencies {
  readonly providerIO: ProviderObjectIO;
  readonly scanner: MalwareScanner;
}

export function createScanValidationRunner(deps: ScanValidationRunnerDependencies): JobRunner {
  return async ({ object }): Promise<JobRunResult | void> => {
    return runRunnerWithErrorMapping(async () => {
      const bytes = await readObjectForProcessing(deps.providerIO, object, MAX_SCANNER_INPUT_BYTES);

      // 3) Scan.
      const result = await deps.scanner.scan({ bytes, contentType: object.contentType });
      switch (result.verdict) {
        case 'clean':
          return {};
        case 'infected':
          throw new RunnerInputError('MALWARE_DETECTED');
        case 'limit_exceeded':
          throw new RunnerInputError('ARCHIVE_INSPECTION_REJECTED');
        case 'unknown':
          throw new RunnerExecutionError('SCANNER_INCONCLUSIVE', {
            retryable: result.retryable !== false,
          });
      }
    });
  };
}
