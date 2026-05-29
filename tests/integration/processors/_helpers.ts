/**
 * STORAGE-FU-5-FU-F — shared helpers for the fixture-based
 * integration suite.
 *
 * Owns:
 *   - `loadFixture(name)` → reads a committed fixture into a
 *     `Uint8Array`. Throws a loud error if the fixture is missing
 *     (e.g. someone forgot to commit binary files).
 *   - `describeIfBinary(binary, label, fn)` → describe-block gate
 *     that soft-skips when the named binary is not on PATH AND the
 *     hard-fail env var is NOT set. Mirrors the STORAGE-FU-2
 *     `connectOrSkip` pattern.
 *   - `describeIfEnv(envVar, label, fn)` → describe-block gate
 *     for tests that need a service URL (libreoffice sidecar,
 *     clamd) rather than a CLI binary on PATH.
 *
 * Hard-fail env var: `STORAGE_INTEGRATION_PROCESSORS_REQUIRED=1`.
 * When set, missing binaries / env vars throw a clear failure
 * BEFORE the describe block runs (so CI does not silently skip
 * integration coverage).
 */
import { describe } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const FIXTURES_DIR = join(dirname(new URL(import.meta.url).pathname), 'fixtures');

export type FixtureName = 'sample.jpg' | 'sample.png' | 'sample.mp4' | 'sample.pdf' | 'eicar.txt';

/**
 * Read a committed binary fixture into a `Uint8Array`.
 *
 * Throws a clear error if the file is missing — a fixture is part of
 * the committed corpus and its absence is a configuration bug, not a
 * soft-skip condition.
 */
export function loadFixture(name: FixtureName): Uint8Array {
  const path = join(FIXTURES_DIR, name);
  if (!existsSync(path)) {
    throw new Error(
      `STORAGE-FU-5-FU-F fixture missing: ${name} at ${path}. ` +
        `Run \`bun run tests/integration/processors/fixtures/_generate.ts\` ` +
        `to regenerate.`,
    );
  }
  return new Uint8Array(readFileSync(path));
}

/**
 * Read a fixture as UTF-8 text. Used for `eicar.txt`.
 */
export function loadFixtureText(name: FixtureName): string {
  const path = join(FIXTURES_DIR, name);
  if (!existsSync(path)) {
    throw new Error(
      `STORAGE-FU-5-FU-F fixture missing: ${name} at ${path}. ` +
        `Run \`bun run tests/integration/processors/fixtures/_generate.ts\` ` +
        `to regenerate.`,
    );
  }
  return readFileSync(path, 'utf-8');
}

const PROCESSORS_REQUIRED =
  (process.env.STORAGE_INTEGRATION_PROCESSORS_REQUIRED ?? '').trim() === '1';

/**
 * Looks up a binary on PATH via `which`. Returns `null` if missing.
 * Wraps `Bun.spawnSync` so callers don't have to worry about
 * cross-platform shell quoting.
 */
export function whichBinary(name: string): string | null {
  const proc = Bun.spawnSync({
    cmd: ['which', name],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) return null;
  const out = new TextDecoder().decode(proc.stdout).trim();
  return out.length > 0 ? out : null;
}

/**
 * Describe-block gate that runs when the named CLI binary is on
 * PATH. When missing, the block is skipped locally (clean laptop
 * without ffmpeg / soffice / clamscan installed) BUT hard-fails when
 * `STORAGE_INTEGRATION_PROCESSORS_REQUIRED=1`.
 *
 * Inside the `fn` callback, callers can rely on
 * `whichBinary(name)` returning the resolved path.
 *
 * IMPORTANT: when the binary is missing AND the suite is being
 * soft-skipped, the `fn` body is NEVER evaluated. Bun's
 * `describe.skip(label, fn)` still invokes `fn` at registration time
 * (only the test bodies inside are marked skipped), so we register
 * a no-op placeholder block instead. This lets the suite under `fn`
 * eagerly construct processor instances at the top of the block
 * without crashing the test runner on a clean laptop.
 */
export function describeIfBinary(binary: string, label: string, fn: () => void): void {
  const path = whichBinary(binary);
  if (path !== null) {
    describe(label, fn);
    return;
  }
  if (PROCESSORS_REQUIRED) {
    describe(label, () => {
      throw new Error(
        `STORAGE-FU-5-FU-F: required binary "${binary}" not on PATH and ` +
          `STORAGE_INTEGRATION_PROCESSORS_REQUIRED=1.`,
      );
    });
    return;
  }
  // Soft-skip: do NOT pass `fn` so the body never evaluates.
  describe.skip(`${label} (skipped: ${binary} not on PATH)`, () => {
    /* fn body intentionally omitted in soft-skip mode */
  });
}

/**
 * Describe-block gate that runs when the named env var is set
 * (e.g. `CLAMD_HOST`, `LIBREOFFICE_SERVICE_URL`).
 *
 * Same soft-skip semantics as `describeIfBinary`: the `fn` body is
 * NEVER evaluated when the env var is unset, so processors that
 * throw at construction time on missing config (e.g.
 * `LibreOfficeDocumentProcessor` rejecting an empty URL) do not
 * crash the test runner.
 */
export function describeIfEnv(envVar: string, label: string, fn: () => void): void {
  const value = process.env[envVar];
  if (value !== undefined && value.trim() !== '') {
    describe(label, fn);
    return;
  }
  if (PROCESSORS_REQUIRED) {
    describe(label, () => {
      throw new Error(
        `STORAGE-FU-5-FU-F: required env var "${envVar}" is unset and ` +
          `STORAGE_INTEGRATION_PROCESSORS_REQUIRED=1.`,
      );
    });
    return;
  }
  describe.skip(`${label} (skipped: ${envVar} unset)`, () => {
    /* fn body intentionally omitted in soft-skip mode */
  });
}

/**
 * Returns a string identifying the fixture corpus version. Tests
 * that snapshot fixture sizes can include this in their diagnostic
 * output so a maintainer can tell at a glance if the corpus drifted.
 */
export function fixtureCorpusSummary(): string {
  const names: FixtureName[] = [
    'sample.jpg',
    'sample.png',
    'sample.mp4',
    'sample.pdf',
    'eicar.txt',
  ];
  const sizes = names
    .map((n) => {
      try {
        return `${n}=${loadFixture(n).length}`;
      } catch {
        return `${n}=<missing>`;
      }
    })
    .join(' ');
  return `STORAGE-FU-5-FU-F corpus: ${sizes}`;
}
