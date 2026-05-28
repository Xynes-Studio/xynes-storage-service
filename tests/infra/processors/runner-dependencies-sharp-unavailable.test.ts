/**
 * STORAGE-FU-5-FU-A — sharp-unavailable fallback regression guard
 * (PR #15 Codex P1).
 *
 * What this guards against
 * ------------------------
 *
 * The PR #15 Codex review flagged a P1 defect: the original
 * implementation did `import { SharpImageProcessor } from
 * './sharp-image-processor'` statically, which evaluated
 * `sharp-image-processor.ts`'s module-level `import sharp from 'sharp'`
 * AND `sharp.cache(false)` at runner-dependencies load time. If the
 * sharp native binding is missing or corrupted (e.g. an Alpine image
 * without libvips, an unsupported CPU arch, or a botched npm install),
 * the whole process would crash BEFORE `buildLiveImageProcessor()`
 * could catch the failure — AND `STORAGE_PROCESSOR_MODE=stub` would
 * also fail to boot even though stub mode never needs sharp.
 *
 * The fix lazy-loads `SharpImageProcessor` via `createRequire` inside
 * `buildLiveImageProcessor()`, with an injectable test seam so this
 * test does NOT need Bun's process-wide `mock.module('sharp', ...)`.
 *
 * Why a test seam (not `mock.module`)
 * -----------------------------------
 *
 * Bun's `mock.module` is process-wide. A previous version of this
 * file used it and broke neighbouring tests in the same `bun test`
 * run because module-cache state could not be reliably restored. The
 * `__forTesting__.buildLiveImageProcessor(loader)` seam mirrors the
 * production code path exactly — same try/catch, same WARN posture,
 * same fallback — without ever touching the global sharp import.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { __forTesting__ } from '../../../src/infra/processors/runner-dependencies';
import { ProductionImageProcessorStub } from '../../../src/infra/processors/production-processors';
import { SharpImageProcessor } from '../../../src/infra/processors/sharp-image-processor';

// Capture WARN output for assertion.
let warnSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  __forTesting__.resetSharpFallbackLogged();
});
afterEach(() => {
  warnSpy.mockRestore();
  __forTesting__.resetSharpFallbackLogged();
});

describe('STORAGE-FU-5-FU-A — sharp unavailable fallback (PR #15 Codex P1)', () => {
  test('default loader returns the real SharpImageProcessor (live mode happy path)', () => {
    const result = __forTesting__.buildLiveImageProcessor();
    expect(result).toBeInstanceOf(SharpImageProcessor);
    // No WARN emitted on the happy path.
    const sharpWarns = warnSpy.mock.calls.filter((args: unknown[]) =>
      String(args[0] ?? '').includes('sharp unavailable'),
    );
    expect(sharpWarns.length).toBe(0);
  });

  test('loader throwing (sharp missing) falls back to ProductionImageProcessorStub', () => {
    const result = __forTesting__.buildLiveImageProcessor(() => {
      throw new Error('libvips binding missing — fixture-only failure');
    });
    expect(result).toBeInstanceOf(ProductionImageProcessorStub);
    // Single WARN per process — the latch is honoured.
    const sharpWarns = warnSpy.mock.calls.filter((args: unknown[]) =>
      String(args[0] ?? '').includes('sharp unavailable'),
    );
    expect(sharpWarns.length).toBe(1);
  });

  test('WARN message NEVER carries a raw library hint (STORAGE-9 redaction)', () => {
    __forTesting__.buildLiveImageProcessor(() => {
      throw new Error('libvips.so.42: cannot open shared object file: No such file or directory');
    });
    const sharpWarns = warnSpy.mock.calls.filter((args: unknown[]) =>
      String(args[0] ?? '').includes('sharp unavailable'),
    );
    expect(sharpWarns.length).toBe(1);
    const msg = String(sharpWarns[0][0]);
    // The closed-set WARN must not leak the inner error string.
    expect(msg).not.toMatch(/libvips/i);
    expect(msg).not.toMatch(/\.so\./i);
    expect(msg).not.toMatch(/shared object/i);
  });

  test('subsequent loader-throws do NOT re-emit the WARN within one process', () => {
    const failingLoader = () => {
      throw new Error('libvips binding missing — fixture-only failure');
    };
    // First call emits exactly one WARN.
    __forTesting__.buildLiveImageProcessor(failingLoader);
    expect(
      warnSpy.mock.calls.filter((args: unknown[]) =>
        String(args[0] ?? '').includes('sharp unavailable'),
      ).length,
    ).toBe(1);
    // Second call must NOT re-emit.
    __forTesting__.buildLiveImageProcessor(failingLoader);
    expect(
      warnSpy.mock.calls.filter((args: unknown[]) =>
        String(args[0] ?? '').includes('sharp unavailable'),
      ).length,
    ).toBe(1);
  });

  test('fallback to production stub yields a retryable PROCESSOR_FAILED for image_optimize', async () => {
    const fallback = __forTesting__.buildLiveImageProcessor(() => {
      throw new Error('libvips binding missing — fixture-only failure');
    });
    // The production stub throws `RunnerInputError('UNSUPPORTED_FORMAT')`
    // on any call; the runner remaps that to a retryable
    // PROCESSOR_FAILED, but at this layer we just confirm the stub
    // is in place and produces a runner-error.
    expect(fallback).toBeInstanceOf(ProductionImageProcessorStub);
    let threw = false;
    try {
      await fallback.probe({ bytes: new Uint8Array() });
    } catch (err) {
      threw = true;
      // The closed-set code reaches us — the inner library text does
      // not.
      expect((err as Error).message).toBe('UNSUPPORTED_FORMAT');
    }
    expect(threw).toBe(true);
  });
});
