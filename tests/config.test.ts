import { describe, expect, test } from 'bun:test';
import { loadConfig } from '../src/infra/config';

describe('loadConfig', () => {
  test('applies dev-friendly defaults when env is empty', () => {
    const config = loadConfig({});
    expect(config.port).toBe(4204);
    expect(config.internalServiceToken).toBeNull();
    expect(config.internalAuthMode).toBe('hybrid');
    expect(config.multipartThresholdBytes).toBe(100 * 1024 * 1024);
  });

  test('honours PORT when valid', () => {
    expect(loadConfig({ PORT: '4444' }).port).toBe(4444);
  });

  test('falls back to default when PORT is non-numeric', () => {
    expect(loadConfig({ PORT: 'abc' }).port).toBe(4204);
  });

  test('falls back to default when PORT is out of range', () => {
    expect(loadConfig({ PORT: '70000' }).port).toBe(4204);
    expect(loadConfig({ PORT: '-1' }).port).toBe(4204);
    expect(loadConfig({ PORT: '0' }).port).toBe(4204);
  });

  test('honours INTERNAL_AUTH_MODE=jwt', () => {
    expect(loadConfig({ INTERNAL_AUTH_MODE: 'jwt' }).internalAuthMode).toBe('jwt');
  });

  test('defaults INTERNAL_AUTH_MODE to hybrid for any other value', () => {
    expect(loadConfig({ INTERNAL_AUTH_MODE: 'other' }).internalAuthMode).toBe('hybrid');
  });

  test('honours STORAGE_MULTIPART_THRESHOLD_BYTES when valid', () => {
    expect(
      loadConfig({ STORAGE_MULTIPART_THRESHOLD_BYTES: '200000000' }).multipartThresholdBytes,
    ).toBe(200_000_000);
  });

  test('falls back to default multipart threshold when invalid', () => {
    expect(loadConfig({ STORAGE_MULTIPART_THRESHOLD_BYTES: 'abc' }).multipartThresholdBytes).toBe(
      100 * 1024 * 1024,
    );
    expect(loadConfig({ STORAGE_MULTIPART_THRESHOLD_BYTES: '0' }).multipartThresholdBytes).toBe(
      100 * 1024 * 1024,
    );
  });

  test('honours MAX_JSON_BODY_BYTES when valid', () => {
    expect(loadConfig({ MAX_JSON_BODY_BYTES: '2048' }).maxJsonBodyBytes).toBe(2048);
  });

  test('falls back to default max body bytes when invalid', () => {
    expect(loadConfig({ MAX_JSON_BODY_BYTES: 'abc' }).maxJsonBodyBytes).toBe(1024 * 1024);
  });

  test('captures internalServiceToken when set', () => {
    expect(loadConfig({ INTERNAL_SERVICE_TOKEN: 'tok' }).internalServiceToken).toBe('tok');
  });
});
