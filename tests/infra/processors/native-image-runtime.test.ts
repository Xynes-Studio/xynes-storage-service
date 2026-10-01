import { describe, expect, test } from 'bun:test';
import sharp from 'sharp';
import { assertSafeNativeImageRuntime } from '../../../src/infra/processors/native-image-runtime';

const patched = { sharp: '0.35.5', heif: '1.23.5', vips: '8.18.7' };

describe('XYN-SEC-001 native image runtime gate', () => {
  test('the installed native runtime meets the security floor', () => {
    expect(() => assertSafeNativeImageRuntime(sharp.versions)).not.toThrow();
    expect(sharp.format.heif.input.buffer).toBe(true);
  });

  test('accepts patched and newer stable builds', () => {
    expect(() => assertSafeNativeImageRuntime(patched)).not.toThrow();
    expect(() =>
      assertSafeNativeImageRuntime({ sharp: '0.36.0', heif: '1.24.0', vips: '9.0.0' }),
    ).not.toThrow();
  });

  test.each([
    { ...patched, sharp: '0.34.5' },
    { ...patched, heif: '1.23.4' },
    { ...patched, vips: '8.18.2' },
    { ...patched, sharp: '0.35.5-rc.1' },
    { ...patched, heif: 'unverified' },
    { ...patched, vips: '8.18' },
    { ...patched, vips: '8.18.7.1' },
    { ...patched, heif: '' },
    { ...patched, sharp: '99999999999999999999.0.0' },
    {},
  ])('rejects unsafe, missing or unverifiable decoder versions: %j', (versions) => {
    expect(() => assertSafeNativeImageRuntime(versions)).toThrow('UNSAFE_NATIVE_IMAGE_RUNTIME');
  });
});
