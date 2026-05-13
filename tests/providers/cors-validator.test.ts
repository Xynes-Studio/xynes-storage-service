/**
 * CORS config validator tests.
 *
 * Plan §3 + STORAGE-9 binding constraint: Backblaze B2 is the tightest of
 * the three MVP-ready providers — ≤ 100 KB payload, `MaxAgeSeconds ∈
 * [0, 86400]`, non-empty `AllowedOrigin`. The validator enforces these on
 * the normalised internal shape so the same input works on every provider
 * without per-caller branching.
 */
import { describe, expect, test } from 'bun:test';
import { ProviderAdapterError } from '../../src/infra/providers/errors';
import { validateCorsConfig, type CorsConfig } from '../../src/infra/providers/cors-validator';

function buildBaseConfig(): CorsConfig {
  return {
    rules: [
      {
        allowedOrigins: ['https://app.example.com'],
        allowedMethods: ['GET', 'PUT'],
        maxAgeSeconds: 3600,
      },
    ],
  };
}

describe('validateCorsConfig', () => {
  test('accepts a baseline single-rule config', () => {
    expect(() => validateCorsConfig(buildBaseConfig())).not.toThrow();
  });

  test('rejects an empty rule list', () => {
    expect(() => validateCorsConfig({ rules: [] })).toThrow(ProviderAdapterError);
  });

  test('rejects a rule with no AllowedOrigin (B2 binding constraint)', () => {
    expect(() =>
      validateCorsConfig({
        rules: [{ allowedOrigins: [], allowedMethods: ['GET'] }],
      }),
    ).toThrow(ProviderAdapterError);
  });

  test('rejects a rule whose AllowedOrigin contains an empty string', () => {
    expect(() =>
      validateCorsConfig({
        rules: [{ allowedOrigins: [''], allowedMethods: ['GET'] }],
      }),
    ).toThrow(ProviderAdapterError);
  });

  test('rejects a rule whose AllowedOrigin contains a whitespace-only string', () => {
    expect(() =>
      validateCorsConfig({
        rules: [{ allowedOrigins: ['   '], allowedMethods: ['GET'] }],
      }),
    ).toThrow(ProviderAdapterError);
  });

  test('rejects a rule with no AllowedMethod', () => {
    expect(() =>
      validateCorsConfig({
        rules: [{ allowedOrigins: ['https://app.example.com'], allowedMethods: [] }],
      }),
    ).toThrow(ProviderAdapterError);
  });

  test('rejects MaxAgeSeconds < 0', () => {
    expect(() =>
      validateCorsConfig({
        rules: [
          {
            allowedOrigins: ['https://app.example.com'],
            allowedMethods: ['GET'],
            maxAgeSeconds: -1,
          },
        ],
      }),
    ).toThrow(ProviderAdapterError);
  });

  test('rejects MaxAgeSeconds > 86 400 (B2 binding constraint)', () => {
    expect(() =>
      validateCorsConfig({
        rules: [
          {
            allowedOrigins: ['https://app.example.com'],
            allowedMethods: ['GET'],
            maxAgeSeconds: 86_401,
          },
        ],
      }),
    ).toThrow(ProviderAdapterError);
  });

  test('rejects MaxAgeSeconds that is not an integer', () => {
    expect(() =>
      validateCorsConfig({
        rules: [
          {
            allowedOrigins: ['https://app.example.com'],
            allowedMethods: ['GET'],
            maxAgeSeconds: 3600.5,
          },
        ],
      }),
    ).toThrow(ProviderAdapterError);
  });

  test('accepts MaxAgeSeconds at the 86 400 boundary', () => {
    expect(() =>
      validateCorsConfig({
        rules: [
          {
            allowedOrigins: ['https://app.example.com'],
            allowedMethods: ['GET'],
            maxAgeSeconds: 86_400,
          },
        ],
      }),
    ).not.toThrow();
  });

  test('accepts MaxAgeSeconds at the 0 boundary', () => {
    expect(() =>
      validateCorsConfig({
        rules: [
          {
            allowedOrigins: ['https://app.example.com'],
            allowedMethods: ['GET'],
            maxAgeSeconds: 0,
          },
        ],
      }),
    ).not.toThrow();
  });

  test('rejects serialised payload > 100 KB (B2 binding constraint)', () => {
    expect(() => validateCorsConfig(buildBaseConfig(), 100 * 1024 + 1)).toThrow(
      ProviderAdapterError,
    );
  });

  test('accepts serialised payload at the 100 KB boundary', () => {
    expect(() => validateCorsConfig(buildBaseConfig(), 100 * 1024)).not.toThrow();
  });

  test('error code is PROVIDER_CONFIG_INVALID for all failure modes', () => {
    try {
      validateCorsConfig({ rules: [] });
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderAdapterError);
      expect((err as ProviderAdapterError).code).toBe('PROVIDER_CONFIG_INVALID');
    }
  });

  test('error messages do not leak internal byte counts beyond what the caller already knows', () => {
    try {
      validateCorsConfig(buildBaseConfig(), 200_000);
    } catch (err) {
      const msg = (err as Error).message;
      // The error MUST mention the limit so the operator can fix the input,
      // but MUST NOT carry credentials or signed URLs (sanity check; the
      // validator never touches credentials).
      expect(msg).toContain('100');
      expect(msg.toLowerCase()).not.toContain('accesskey');
      expect(msg.toLowerCase()).not.toContain('secret');
      expect(msg.toLowerCase()).not.toContain('signature');
    }
  });
});
