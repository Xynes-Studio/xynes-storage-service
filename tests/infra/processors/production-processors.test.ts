/**
 * STORAGE-FU-5 — production processor stub tests.
 *
 * The production-mode stubs throw `UNSUPPORTED_FORMAT` until the
 * follow-up infra story wires real sharp / ffmpeg / libreoffice. They
 * exist so hosted deployments that flip `STORAGE_PROCESSOR_MODE=live`
 * before the binaries are installed see DETERMINISTIC closed-set
 * failures instead of opaque crashes.
 *
 * Invariants verified:
 *   - Every production stub method throws a `RunnerInputError` with
 *     code `UNSUPPORTED_FORMAT` (non-retryable per STORAGE-7
 *     planner — dead-letters immediately).
 *   - The error message NEVER carries a raw library name or hint that
 *     could be parsed as a vulnerability scanner signal.
 */
import { describe, expect, test } from 'bun:test';
import {
  ProductionDocumentProcessorStub,
  ProductionImageProcessorStub,
  ProductionVideoProcessorStub,
} from '../../../src/infra/processors/production-processors';
import { RunnerInputError } from '../../../src/actions/handlers/processing/runners/errors';

function assertUnsupportedFormat(err: unknown): asserts err is RunnerInputError {
  expect(err).toBeInstanceOf(RunnerInputError);
  expect((err as RunnerInputError).code).toBe('UNSUPPORTED_FORMAT');
  expect((err as RunnerInputError).retryable).toBe(false);
}

describe('ProductionImageProcessorStub', () => {
  test('probe throws UNSUPPORTED_FORMAT', async () => {
    const p = new ProductionImageProcessorStub();
    try {
      await p.probe({ bytes: new Uint8Array() });
      throw new Error('did not throw');
    } catch (err) {
      assertUnsupportedFormat(err);
    }
  });

  test('renderVariant throws UNSUPPORTED_FORMAT', async () => {
    const p = new ProductionImageProcessorStub();
    try {
      await p.renderVariant({
        bytes: new Uint8Array(),
        spec: {
          role: 'thumbnail_small',
          maxWidth: 320,
          maxHeight: 320,
          quality: 75,
          format: 'webp',
        },
      });
      throw new Error('did not throw');
    } catch (err) {
      assertUnsupportedFormat(err);
    }
  });
});

describe('ProductionVideoProcessorStub', () => {
  test('probe throws UNSUPPORTED_FORMAT', async () => {
    const p = new ProductionVideoProcessorStub();
    try {
      await p.probe({ bytes: new Uint8Array() });
      throw new Error('did not throw');
    } catch (err) {
      assertUnsupportedFormat(err);
    }
  });

  test('renderPoster throws UNSUPPORTED_FORMAT', async () => {
    const p = new ProductionVideoProcessorStub();
    try {
      await p.renderPoster({
        bytes: new Uint8Array(),
        profile: {
          profile: 'balanced',
          codec: 'h264',
          audioCodec: 'aac',
          container: 'mp4',
          maxWidth: 1280,
          maxHeight: 720,
          targetBitrateKbps: 2500,
          posterMaxWidth: 640,
          posterMaxHeight: 360,
        },
      });
      throw new Error('did not throw');
    } catch (err) {
      assertUnsupportedFormat(err);
    }
  });

  test('renderTranscode throws UNSUPPORTED_FORMAT', async () => {
    const p = new ProductionVideoProcessorStub();
    try {
      await p.renderTranscode({
        bytes: new Uint8Array(),
        profile: {
          profile: 'balanced',
          codec: 'h264',
          audioCodec: 'aac',
          container: 'mp4',
          maxWidth: 1280,
          maxHeight: 720,
          targetBitrateKbps: 2500,
          posterMaxWidth: 640,
          posterMaxHeight: 360,
        },
      });
      throw new Error('did not throw');
    } catch (err) {
      assertUnsupportedFormat(err);
    }
  });
});

describe('ProductionDocumentProcessorStub', () => {
  test('renderFirstPagePreview throws UNSUPPORTED_FORMAT', async () => {
    const p = new ProductionDocumentProcessorStub();
    try {
      await p.renderFirstPagePreview({
        bytes: new Uint8Array(),
        sourceContentType: 'application/pdf',
      });
      throw new Error('did not throw');
    } catch (err) {
      assertUnsupportedFormat(err);
    }
  });
});

describe('Production stubs — error redaction', () => {
  test('RunnerInputError message is exactly the code, never a library name', async () => {
    const errs: RunnerInputError[] = [];
    const collect = async (fn: () => Promise<unknown>): Promise<void> => {
      try {
        await fn();
      } catch (err) {
        if (err instanceof RunnerInputError) errs.push(err);
      }
    };
    const img = new ProductionImageProcessorStub();
    const vid = new ProductionVideoProcessorStub();
    const doc = new ProductionDocumentProcessorStub();
    await collect(() => img.probe({ bytes: new Uint8Array() }));
    await collect(() => vid.probe({ bytes: new Uint8Array() }));
    await collect(() =>
      doc.renderFirstPagePreview({
        bytes: new Uint8Array(),
        sourceContentType: 'application/pdf',
      }),
    );
    expect(errs.length).toBeGreaterThan(0);
    for (const e of errs) {
      expect(e.message).toBe('UNSUPPORTED_FORMAT');
      expect(e.message).not.toMatch(/sharp|ffmpeg|libreoffice|libvips|soffice/i);
    }
  });
});
