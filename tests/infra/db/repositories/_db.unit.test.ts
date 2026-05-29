/**
 * STORAGE-FU-2-FU-3 — unit tests for `_db.ts` helpers.
 *
 * These tests run WITHOUT a DB connection. They lock in the contract:
 *
 *   1. `sanitizeUrlForLogging` strips `user:password@` from the URL
 *      so the CI error message never surfaces the DB password.
 *   2. `isIntegrationDbRequired` honours the closed-set
 *      `STORAGE_INTEGRATION_DB_REQUIRED='1'` opt-in (NOT truthy
 *      coercion).
 *   3. `connectOrSkip` returns `null` cleanly when the DB is
 *      unreachable and the hard-fail env var is unset (local-dev
 *      posture preserved).
 *   4. `connectOrSkip` throws a credential-sanitized error when the
 *      hard-fail env var is set and the DB is unreachable
 *      (CI posture).
 *
 * The "connection unreachable" path is exercised by pointing
 * `STORAGE_INTEGRATION_DB_URL` at a host that is guaranteed not to
 * accept connections (TCP port 1 on the loopback interface). This
 * avoids needing a Docker dependency for the unit suite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { connectOrSkip, isIntegrationDbRequired, sanitizeUrlForLogging } from './_db';

// An address that will reliably refuse TCP connections. Port 1 is the
// IANA-reserved `tcpmux` port; nothing is bound to it in CI runners.
const UNREACHABLE_URL = 'postgresql://postgres:s3cret-password@127.0.0.1:1/postgres';

describe('STORAGE-FU-2-FU-3 — sanitizeUrlForLogging', () => {
  test('strips userinfo from a standard postgres URL', () => {
    const host = sanitizeUrlForLogging(
      'postgresql://postgres:s3cret-password@db.internal:5432/storage',
    );
    expect(host).toBe('db.internal:5432');
    expect(host).not.toContain('postgres');
    expect(host).not.toContain('s3cret-password');
  });

  test('preserves the port when present', () => {
    expect(sanitizeUrlForLogging('postgresql://u:p@host.example:5433/db')).toBe(
      'host.example:5433',
    );
  });

  test('omits the port when not present', () => {
    expect(sanitizeUrlForLogging('postgresql://u:p@host.example/db')).toBe('host.example');
  });

  test('returns `<unparseable>` for malformed URLs', () => {
    expect(sanitizeUrlForLogging('not-a-valid-url')).toBe('<unparseable>');
  });

  test('returns `<unparseable>` for empty string', () => {
    expect(sanitizeUrlForLogging('')).toBe('<unparseable>');
  });

  test('never surfaces credentials from hostile URLs', () => {
    // Defense-in-depth: a URL with a credential-looking hostname must
    // still only return the host:port pair, never the userinfo.
    const hostile =
      'postgresql://AKIA-LEAK-1234:xynes_live_abc123@db.internal:5432/storage?password=plaintext';
    const sanitized = sanitizeUrlForLogging(hostile);
    expect(sanitized).toBe('db.internal:5432');
    expect(sanitized).not.toContain('AKIA-LEAK-1234');
    expect(sanitized).not.toContain('xynes_live_abc123');
    expect(sanitized).not.toContain('plaintext');
  });
});

describe('STORAGE-FU-2-FU-3 — isIntegrationDbRequired', () => {
  // Save + restore the env var around each test so test order doesn't
  // bleed state.
  const originalValue = process.env.STORAGE_INTEGRATION_DB_REQUIRED;

  beforeEach(() => {
    delete process.env.STORAGE_INTEGRATION_DB_REQUIRED;
  });

  afterAll(() => {
    if (originalValue === undefined) {
      delete process.env.STORAGE_INTEGRATION_DB_REQUIRED;
    } else {
      process.env.STORAGE_INTEGRATION_DB_REQUIRED = originalValue;
    }
  });

  test('returns false when the env var is unset', () => {
    expect(isIntegrationDbRequired()).toBe(false);
  });

  test('returns true when the env var is exactly `"1"`', () => {
    process.env.STORAGE_INTEGRATION_DB_REQUIRED = '1';
    expect(isIntegrationDbRequired()).toBe(true);
  });

  test('returns false for "true" (NOT truthy coercion)', () => {
    process.env.STORAGE_INTEGRATION_DB_REQUIRED = 'true';
    expect(isIntegrationDbRequired()).toBe(false);
  });

  test('returns false for "yes" (NOT truthy coercion)', () => {
    process.env.STORAGE_INTEGRATION_DB_REQUIRED = 'yes';
    expect(isIntegrationDbRequired()).toBe(false);
  });

  test('returns false for "0"', () => {
    process.env.STORAGE_INTEGRATION_DB_REQUIRED = '0';
    expect(isIntegrationDbRequired()).toBe(false);
  });

  test('returns false for empty string', () => {
    process.env.STORAGE_INTEGRATION_DB_REQUIRED = '';
    expect(isIntegrationDbRequired()).toBe(false);
  });
});

describe('STORAGE-FU-2-FU-3 — connectOrSkip hard-fail behaviour', () => {
  // Save + restore the env vars so neighbouring suites (like the
  // integration suite that imports this helper) are not affected.
  const originalRequired = process.env.STORAGE_INTEGRATION_DB_REQUIRED;
  const originalUrl = process.env.STORAGE_INTEGRATION_DB_URL;

  beforeAll(() => {
    // Force an unreachable URL so the function deterministically hits
    // the error branch instead of accidentally connecting to a real
    // Supabase stack that happens to be running locally.
    process.env.STORAGE_INTEGRATION_DB_URL = UNREACHABLE_URL;
  });

  beforeEach(() => {
    delete process.env.STORAGE_INTEGRATION_DB_REQUIRED;
  });

  afterAll(() => {
    if (originalRequired === undefined) {
      delete process.env.STORAGE_INTEGRATION_DB_REQUIRED;
    } else {
      process.env.STORAGE_INTEGRATION_DB_REQUIRED = originalRequired;
    }
    if (originalUrl === undefined) {
      delete process.env.STORAGE_INTEGRATION_DB_URL;
    } else {
      process.env.STORAGE_INTEGRATION_DB_URL = originalUrl;
    }
  });

  test('returns null when DB unreachable and STORAGE_INTEGRATION_DB_REQUIRED is unset', async () => {
    const result = await connectOrSkip();
    expect(result).toBeNull();
  });

  test('throws a credential-sanitized error when DB unreachable and STORAGE_INTEGRATION_DB_REQUIRED=1', async () => {
    process.env.STORAGE_INTEGRATION_DB_REQUIRED = '1';
    let caught: unknown = null;
    try {
      await connectOrSkip();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain('STORAGE_INTEGRATION_DB_REQUIRED=1');
    expect(message).toContain('127.0.0.1:1');
    // Critical: the password from the URL must NEVER survive into the
    // error message. The sanitization layer strips userinfo via
    // `sanitizeUrlForLogging`.
    expect(message).not.toContain('s3cret-password');
    expect(message).not.toContain('postgres:s3cret-password');
  });

  test('returns null when STORAGE_INTEGRATION_DB_REQUIRED="true" (NOT truthy coercion)', async () => {
    // A non-`"1"` truthy value must NOT enable hard-fail — this is the
    // closed-set invariant from `isIntegrationDbRequired`.
    process.env.STORAGE_INTEGRATION_DB_REQUIRED = 'true';
    const result = await connectOrSkip();
    expect(result).toBeNull();
  });

  test('local-dev posture preserved: env unset never throws (returns null OR a valid handle)', async () => {
    // Simulate the clean-laptop case: no env vars at all. On a clean
    // CI runner this returns `null` (no DB reachable); on a developer
    // laptop with a running Supabase stack it returns a valid handle.
    // Both outcomes are correct for the local-dev posture — the
    // critical invariant is that NEITHER throws.
    delete process.env.STORAGE_INTEGRATION_DB_URL;
    delete process.env.STORAGE_INTEGRATION_DB_REQUIRED;
    let threw = false;
    let result: Awaited<ReturnType<typeof connectOrSkip>> = null;
    try {
      result = await connectOrSkip();
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    // Either `null` (DB unreachable) or a valid `IntegrationDb` (local
    // Supabase reachable) is acceptable. The clean-laptop invariant
    // is "no throw", NOT "always returns null".
    if (result !== null) {
      // Close the handle so we don't leak a connection across tests.
      await result.handle.close();
    }
    // Restore for any subsequent test ordering.
    process.env.STORAGE_INTEGRATION_DB_URL = UNREACHABLE_URL;
  });
});
