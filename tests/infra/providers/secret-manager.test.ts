/**
 * STORAGE-FU-3 — unit tests for the secret-manager interface.
 *
 * Covers:
 *   - `parseSecretRef` strict URI validation (all rejection paths).
 *   - `secretPathToEnvPrefix` pure mapping.
 *   - `EnvSecretManagerClient` success / NOT_FOUND / MATERIAL_INVALID paths.
 *   - Defense-in-depth: every error message is safe to log (no raw value
 *     echo, no secret leak).
 */
import { describe, expect, test } from 'bun:test';
import {
  EnvSecretManagerClient,
  parseSecretRef,
  secretPathToEnvPrefix,
  SecretManagerError,
} from '../../../src/infra/providers/secret-manager';

describe('parseSecretRef', () => {
  test('accepts a minimal secret:// URI', () => {
    expect(parseSecretRef('secret://r2')).toBe('r2');
  });

  test('accepts a nested path', () => {
    expect(parseSecretRef('secret://storage/r2/dev')).toBe('storage/r2/dev');
  });

  test('trims surrounding whitespace before validating', () => {
    expect(parseSecretRef('  secret://r2  ')).toBe('r2');
  });

  test('rejects non-string input', () => {
    expect(() => parseSecretRef(undefined as unknown as string)).toThrow(SecretManagerError);
    expect(() => parseSecretRef(null as unknown as string)).toThrow(SecretManagerError);
    expect(() => parseSecretRef(42 as unknown as string)).toThrow(SecretManagerError);
  });

  test('rejects empty string', () => {
    expect(() => parseSecretRef('')).toThrow(SecretManagerError);
    expect(() => parseSecretRef('   ')).toThrow(SecretManagerError);
  });

  test('rejects non-secret schemes', () => {
    expect(() => parseSecretRef('http://example.com/key')).toThrow(SecretManagerError);
    expect(() => parseSecretRef('https://example.com/key')).toThrow(SecretManagerError);
    expect(() => parseSecretRef('file:///etc/secrets')).toThrow(SecretManagerError);
    expect(() => parseSecretRef('ftp://example.com')).toThrow(SecretManagerError);
  });

  test('rejects bare secret:// with empty path', () => {
    expect(() => parseSecretRef('secret://')).toThrow(SecretManagerError);
  });

  test('rejects a path that exceeds 256 chars', () => {
    const huge = 'a'.repeat(257);
    expect(() => parseSecretRef(`secret://${huge}`)).toThrow(SecretManagerError);
  });

  test('rejects a path that starts with /', () => {
    expect(() => parseSecretRef('secret:///abs')).toThrow(SecretManagerError);
  });

  test('rejects a path that contains ..', () => {
    expect(() => parseSecretRef('secret://a/../b')).toThrow(SecretManagerError);
  });

  test('rejects a path that contains a query component', () => {
    expect(() => parseSecretRef('secret://a?b=1')).toThrow(SecretManagerError);
  });

  test('rejects a path that contains a fragment', () => {
    expect(() => parseSecretRef('secret://a#frag')).toThrow(SecretManagerError);
  });

  test('rejects uppercase characters', () => {
    expect(() => parseSecretRef('secret://Storage')).toThrow(SecretManagerError);
  });

  test('rejects forbidden characters (spaces, dots, colons)', () => {
    expect(() => parseSecretRef('secret://a b')).toThrow(SecretManagerError);
    expect(() => parseSecretRef('secret://a.b')).toThrow(SecretManagerError);
    expect(() => parseSecretRef('secret://a:b')).toThrow(SecretManagerError);
  });

  test('rejects underscores in the path (PR-11 Codex P2: keeps env mapping injective)', () => {
    // `_` is deliberately forbidden so it cannot collide with the
    // `secretPathToEnvPrefix` encoding (where `/` → `__` and `-` → `_`).
    expect(() => parseSecretRef('secret://a_b')).toThrow(SecretManagerError);
    expect(() => parseSecretRef('secret://storage/r2_dev')).toThrow(SecretManagerError);
    try {
      parseSecretRef('secret://a_b');
    } catch (err) {
      expect((err as SecretManagerError).code).toBe('URI_INVALID');
    }
  });

  test('every URI_INVALID error carries the URI_INVALID code', () => {
    try {
      parseSecretRef('http://no');
    } catch (err) {
      expect(err).toBeInstanceOf(SecretManagerError);
      expect((err as SecretManagerError).code).toBe('URI_INVALID');
    }
  });

  test('error messages never echo the raw credential_ref value', () => {
    const hostile = 'secret://contains/a..b';
    try {
      parseSecretRef(hostile);
    } catch (err) {
      expect((err as Error).message).not.toContain(hostile);
    }
  });
});

describe('secretPathToEnvPrefix', () => {
  test('encodes / as double underscore and - as single underscore (injective mapping)', () => {
    // PR-11 Codex P2: distinct credential refs MUST NOT collide.
    expect(secretPathToEnvPrefix('storage/r2/dev')).toBe('STORAGE_CREDENTIAL_STORAGE__R2__DEV');
    expect(secretPathToEnvPrefix('storage/r2-dev')).toBe('STORAGE_CREDENTIAL_STORAGE__R2_DEV');
    expect(secretPathToEnvPrefix('a-b-c')).toBe('STORAGE_CREDENTIAL_A_B_C');
    expect(secretPathToEnvPrefix('r2')).toBe('STORAGE_CREDENTIAL_R2');
  });

  test('PR-11 Codex P2 collision regression: storage/r2/dev and storage/r2-dev produce DIFFERENT prefixes', () => {
    const segmentNested = secretPathToEnvPrefix('storage/r2/dev');
    const hyphenated = secretPathToEnvPrefix('storage/r2-dev');
    expect(segmentNested).not.toBe(hyphenated);
  });

  test('produces deterministic output (pure function)', () => {
    expect(secretPathToEnvPrefix('p/q')).toBe(secretPathToEnvPrefix('p/q'));
  });
});

describe('EnvSecretManagerClient', () => {
  test('resolves both fields from env vars', async () => {
    const env = {
      STORAGE_CREDENTIAL_R2_ACCESS_KEY_ID: 'AKIA-FIXTURE-1234',
      STORAGE_CREDENTIAL_R2_SECRET_ACCESS_KEY: 'fixture-secret-VALUE',
    };
    const client = new EnvSecretManagerClient({ env });
    const result = await client.resolve('secret://r2');
    expect(result).toEqual({
      accessKeyId: 'AKIA-FIXTURE-1234',
      secretAccessKey: 'fixture-secret-VALUE',
    });
  });

  test('throws NOT_FOUND when both env vars are missing', async () => {
    const client = new EnvSecretManagerClient({ env: {} });
    let thrown: unknown;
    try {
      await client.resolve('secret://r2');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SecretManagerError);
    expect((thrown as SecretManagerError).code).toBe('NOT_FOUND');
  });

  test('throws MATERIAL_INVALID when access key is present but secret is missing', async () => {
    const env = { STORAGE_CREDENTIAL_R2_ACCESS_KEY_ID: 'AKIA-ONLY' };
    const client = new EnvSecretManagerClient({ env });
    let thrown: unknown;
    try {
      await client.resolve('secret://r2');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SecretManagerError);
    expect((thrown as SecretManagerError).code).toBe('MATERIAL_INVALID');
  });

  test('throws MATERIAL_INVALID when secret is present but access key is missing', async () => {
    const env = { STORAGE_CREDENTIAL_R2_SECRET_ACCESS_KEY: 'secret-only' };
    const client = new EnvSecretManagerClient({ env });
    let thrown: unknown;
    try {
      await client.resolve('secret://r2');
    } catch (err) {
      thrown = err;
    }
    expect((thrown as SecretManagerError).code).toBe('MATERIAL_INVALID');
  });

  test('throws MATERIAL_INVALID when either field is blank', async () => {
    const env = {
      STORAGE_CREDENTIAL_R2_ACCESS_KEY_ID: '  ',
      STORAGE_CREDENTIAL_R2_SECRET_ACCESS_KEY: 'ok',
    };
    const client = new EnvSecretManagerClient({ env });
    let thrown: unknown;
    try {
      await client.resolve('secret://r2');
    } catch (err) {
      thrown = err;
    }
    expect((thrown as SecretManagerError).code).toBe('MATERIAL_INVALID');
  });

  test('rejects malformed credential_ref with URI_INVALID', async () => {
    const client = new EnvSecretManagerClient({ env: {} });
    let thrown: unknown;
    try {
      await client.resolve('http://oops');
    } catch (err) {
      thrown = err;
    }
    expect((thrown as SecretManagerError).code).toBe('URI_INVALID');
  });

  test('error messages NEVER contain the raw env values', async () => {
    const env = {
      STORAGE_CREDENTIAL_R2_ACCESS_KEY_ID: 'AKIA-LEAK-SHOULD-NOT-APPEAR',
      STORAGE_CREDENTIAL_R2_SECRET_ACCESS_KEY: '',
    };
    const client = new EnvSecretManagerClient({ env });
    let thrown: unknown;
    try {
      await client.resolve('secret://r2');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SecretManagerError);
    expect((thrown as Error).message).not.toContain('AKIA-LEAK-SHOULD-NOT-APPEAR');
  });

  test('falls back to process.env when no env override is provided', async () => {
    // We can't write process.env in a unit test without leaking state, so
    // instead just confirm the no-arg constructor path doesn't throw —
    // the resolve() call uses whatever is in process.env at the time.
    const client = new EnvSecretManagerClient();
    let thrown: unknown;
    try {
      // A unique-enough path that won't accidentally match any real env.
      await client.resolve('secret://storage-fu3-unit-test-fixture');
    } catch (err) {
      thrown = err;
    }
    // Either NOT_FOUND or MATERIAL_INVALID is acceptable here — the
    // assertion is "did not crash".
    expect(thrown).toBeInstanceOf(SecretManagerError);
  });
});
