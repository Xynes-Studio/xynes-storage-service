import { describe, expect, test } from 'bun:test';
import { ProviderAdapterError } from '../../src/infra/providers/errors';

describe('ProviderAdapterError', () => {
  test('defaults to a safe per-code message', () => {
    const e = new ProviderAdapterError('PROVIDER_CONFIG_INVALID');
    expect(e.code).toBe('PROVIDER_CONFIG_INVALID');
    expect(e.message).toContain('configuration');
    expect(e.statusHint).toBe(502);
    expect(e.name).toBe('ProviderAdapterError');
  });

  test('every error code has a safe default message', () => {
    const codes: Array<ProviderAdapterError['code']> = [
      'PROVIDER_CONFIG_INVALID',
      'PROVIDER_OPERATION_FAILED',
      'PROVIDER_OPERATION_REFUSED',
      'PROVIDER_MULTIPART_CONTRACT_VIOLATED',
      'PROVIDER_OBJECT_KEY_INVALID',
      'PROVIDER_PRESIGN_EXPIRY_INVALID',
    ];
    for (const code of codes) {
      const e = new ProviderAdapterError(code);
      // Each default message must be non-empty + not contain secret-shaped values.
      expect(e.message.length).toBeGreaterThan(0);
      expect(e.message.toLowerCase()).not.toContain('accesskey');
      expect(e.message.toLowerCase()).not.toContain('secret');
      expect(e.message.toLowerCase()).not.toContain('x-amz-signature');
    }
  });

  test('honours an override message and a custom statusHint', () => {
    const e = new ProviderAdapterError(
      'PROVIDER_OBJECT_KEY_INVALID',
      'Key contains forbidden character',
      400,
    );
    expect(e.message).toBe('Key contains forbidden character');
    expect(e.statusHint).toBe(400);
  });
});
