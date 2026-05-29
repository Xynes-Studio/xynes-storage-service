/**
 * STORAGE-FU-5-FU-G — resolveConfig tests.
 *
 * Verifies the env-resolution rules: positive-integer parsing,
 * hostname/port defaults, debug flag opt-in.
 */
import { describe, expect, test } from 'bun:test';

import { resolveConfig } from '../src/shim';

describe('resolveConfig — defaults', () => {
  test('returns documented defaults on empty env', () => {
    const config = resolveConfig({});
    expect(config).toEqual({
      port: 8100,
      hostname: '0.0.0.0',
      tmpRoot: '/tmp',
      timeoutMs: 55_000,
      debug: false,
    });
  });
});

describe('resolveConfig — port override', () => {
  test('honours a valid positive integer', () => {
    expect(resolveConfig({ STORAGE_SIDECAR_PORT: '9999' }).port).toBe(9999);
  });

  test('falls back to default on non-numeric', () => {
    expect(resolveConfig({ STORAGE_SIDECAR_PORT: 'abc' }).port).toBe(8100);
  });

  test('falls back to default on zero / negative', () => {
    expect(resolveConfig({ STORAGE_SIDECAR_PORT: '0' }).port).toBe(8100);
    expect(resolveConfig({ STORAGE_SIDECAR_PORT: '-1' }).port).toBe(8100);
  });

  test('falls back to default on float', () => {
    expect(resolveConfig({ STORAGE_SIDECAR_PORT: '3.14' }).port).toBe(8100);
  });

  test('falls back to default on empty string', () => {
    expect(resolveConfig({ STORAGE_SIDECAR_PORT: '' }).port).toBe(8100);
  });

  test('trims surrounding whitespace', () => {
    expect(resolveConfig({ STORAGE_SIDECAR_PORT: ' 8200 ' }).port).toBe(8200);
  });
});

describe('resolveConfig — hostname override', () => {
  test('honours a real hostname', () => {
    expect(resolveConfig({ STORAGE_SIDECAR_HOSTNAME: '127.0.0.1' }).hostname).toBe('127.0.0.1');
  });

  test('falls back to default on whitespace-only', () => {
    expect(resolveConfig({ STORAGE_SIDECAR_HOSTNAME: '   ' }).hostname).toBe('0.0.0.0');
  });
});

describe('resolveConfig — timeoutMs override', () => {
  test('honours a valid positive integer', () => {
    expect(resolveConfig({ STORAGE_SIDECAR_TIMEOUT_MS: '60000' }).timeoutMs).toBe(60_000);
  });

  test('falls back to default on malformed values', () => {
    for (const bad of ['0', '-100', 'three minutes', '3.5']) {
      expect(resolveConfig({ STORAGE_SIDECAR_TIMEOUT_MS: bad }).timeoutMs).toBe(55_000);
    }
  });
});

describe('resolveConfig — debug flag', () => {
  test('enabled exactly on "1"', () => {
    expect(resolveConfig({ STORAGE_SIDECAR_DEBUG: '1' }).debug).toBe(true);
  });

  test('disabled on other truthy strings', () => {
    expect(resolveConfig({ STORAGE_SIDECAR_DEBUG: 'true' }).debug).toBe(false);
    expect(resolveConfig({ STORAGE_SIDECAR_DEBUG: 'yes' }).debug).toBe(false);
    expect(resolveConfig({ STORAGE_SIDECAR_DEBUG: '0' }).debug).toBe(false);
    expect(resolveConfig({ STORAGE_SIDECAR_DEBUG: '' }).debug).toBe(false);
  });
});

describe('resolveConfig — tmpRoot override', () => {
  test('honours a custom path', () => {
    expect(resolveConfig({ STORAGE_SIDECAR_TMP_ROOT: '/var/tmpfs' }).tmpRoot).toBe('/var/tmpfs');
  });

  test('falls back to /tmp on empty / whitespace', () => {
    expect(resolveConfig({ STORAGE_SIDECAR_TMP_ROOT: '   ' }).tmpRoot).toBe('/tmp');
    expect(resolveConfig({ STORAGE_SIDECAR_TMP_ROOT: '' }).tmpRoot).toBe('/tmp');
  });
});
