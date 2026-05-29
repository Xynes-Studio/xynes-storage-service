/**
 * STORAGE-FU-5-FU-F — clamav `MalwareScanner` integration suite.
 *
 * Exercises the live `ClamavMalwareScanner` (FU-5-FU-D) against the
 * committed `eicar.txt` antivirus test vector.
 *
 * The scanner speaks the clamd `zINSTREAM` protocol over TCP (or a
 * unix socket). This suite uses `describeIfEnv('CLAMD_HOST', ...)`
 * AND `describeIfEnv('CLAMD_SOCKET', ...)` so it soft-skips when
 * neither is set (clean laptop without docker compose up) AND
 * hard-fails when `STORAGE_INTEGRATION_PROCESSORS_REQUIRED=1`.
 *
 * In CI, the rollout sequence is:
 *   1. `docker compose up clamav-clamd clamav-freshclam`
 *   2. Wait for `freshclam` to download the signature DB
 *   3. `CLAMD_HOST=clamav-clamd CLAMD_PORT=3310 bun test ...`
 *
 * What the suite proves end-to-end:
 *   - EICAR is detected as `infected` with a signature name
 *     containing `EICAR` (STORAGE-9 §3.6 contract).
 *   - A clean payload (e.g. the committed `sample.pdf`) returns
 *     `verdict: 'clean'`.
 *   - The scanner NEVER coerces an `unknown` result to `clean`
 *     (STORAGE-9 §3.6 invariant; we cannot trigger `unknown`
 *     reliably without breaking the scanner, but the contract is
 *     covered by unit tests).
 */
import { describe, expect, test } from 'bun:test';
import { ClamavMalwareScanner } from '../../../src/infra/processors/clamav-scanner';
import { loadFixture, loadFixtureText } from './_helpers';

function buildScanner(): ClamavMalwareScanner {
  const host = process.env.CLAMD_HOST;
  const portRaw = process.env.CLAMD_PORT;
  const socketPath = process.env.CLAMD_SOCKET;
  return new ClamavMalwareScanner({
    host,
    port: portRaw ? Number.parseInt(portRaw, 10) : undefined,
    socketPath,
  });
}

// Either CLAMD_HOST or CLAMD_SOCKET is enough to opt into this suite.
const haveClamd =
  (process.env.CLAMD_HOST ?? '').trim() !== '' || (process.env.CLAMD_SOCKET ?? '').trim() !== '';

const PROCESSORS_REQUIRED =
  (process.env.STORAGE_INTEGRATION_PROCESSORS_REQUIRED ?? '').trim() === '1';

if (!haveClamd && PROCESSORS_REQUIRED) {
  describe('STORAGE-FU-5-FU-F — ClamavMalwareScanner integration suite', () => {
    test('precondition: clamd reachable', () => {
      throw new Error(
        'STORAGE-FU-5-FU-F: CLAMD_HOST or CLAMD_SOCKET MUST be set when ' +
          'STORAGE_INTEGRATION_PROCESSORS_REQUIRED=1.',
      );
    });
  });
} else if (!haveClamd) {
  // Soft-skip: omit body so processor construction below never runs.
  describe.skip('STORAGE-FU-5-FU-F — ClamavMalwareScanner integration suite (skipped: clamd not configured)', () => {
    /* body intentionally omitted in soft-skip mode */
  });
} else {
  describe('STORAGE-FU-5-FU-F — ClamavMalwareScanner integration suite', () => {
    const scanner = buildScanner();

    test('detects EICAR test vector as `infected` with a matching signature', async () => {
      const eicarBytes = new TextEncoder().encode(loadFixtureText('eicar.txt'));
      const result = await scanner.scan({ bytes: eicarBytes });
      expect(result.verdict).toBe('infected');
      if (result.verdict === 'infected') {
        // clamd canonical signature for EICAR is one of
        // `Win.Test.EICAR_HDB-1` / `Eicar-Signature` / similar
        // — every distro names it slightly differently. Match
        // case-insensitive on the substring `eicar`. The signature
        // field is optional in the contract; the production scanner
        // always emits one for `infected` verdicts.
        expect(result.signature).toBeDefined();
        expect((result.signature ?? '').toLowerCase()).toContain('eicar');
      }
    });

    test('returns `clean` for a benign PDF fixture', async () => {
      const result = await scanner.scan({ bytes: loadFixture('sample.pdf') });
      expect(result.verdict).toBe('clean');
    });

    test('STORAGE-9 §3.6 invariant — clean result NEVER carries a signature field', async () => {
      const result = await scanner.scan({ bytes: loadFixture('sample.png') });
      expect(result.verdict).toBe('clean');
      // Closed-set contract: `clean` results never carry signatures.
      // A test fixture that did would indicate the scanner is
      // mis-mapping protocol responses.
      expect((result as { signature?: string }).signature).toBeUndefined();
    });
  });
}
