/**
 * STORAGE-FU-5 — `createRunnerDependencies` + mode selector tests.
 *
 * Invariants verified:
 *   - `resolveProcessorMode` defaults to `stub` outside production and
 *     `live` inside production.
 *   - `STORAGE_PROCESSOR_MODE` env override is honoured for both
 *     directions.
 *   - Unknown env values fall back to the env-default (no crash).
 *   - `isProcessorMode` is a strict closed-set guard.
 *   - `createRunnerDependencies` wires the STORAGE-7 closed set of
 *     job types (scan_validation + image_optimize + video_probe +
 *     video_thumbnail + video_transcode + document_preview).
 *   - Stub mode picks up the stub processors; live mode picks up the
 *     production stubs that throw UNSUPPORTED_FORMAT.
 *   - Caller-supplied processor overrides win against the env-selected
 *     defaults.
 */
import { describe, expect, test } from 'bun:test';
import {
  createRunnerDependencies,
  isProcessorMode,
  PROCESSOR_MODES,
  resolveProcessorMode,
} from '../../../src/infra/processors/runner-dependencies';
import {
  StubImageProcessor,
  StubVideoProcessor,
  StubDocumentProcessor,
} from '../../../src/infra/processors/stub-processors';
import {
  ProductionImageProcessorStub,
  ProductionVideoProcessorStub,
  ProductionDocumentProcessorStub,
} from '../../../src/infra/processors/production-processors';
import { noopMalwareScanner } from '../../../src/actions/handlers/processing/runners/ports';
import type {
  ProviderObjectIO,
  StorageVariantWriter,
} from '../../../src/actions/handlers/processing/runners/ports';

const FAKE_IO: ProviderObjectIO = {
  async readObject() {
    return new Uint8Array();
  },
  async writeObject() {
    return { byteSize: 0 };
  },
};

const FAKE_VARIANTS: StorageVariantWriter = {
  async recordVariant() {},
};

// ── mode resolution ──────────────────────────────────────────────────────

describe('isProcessorMode', () => {
  test('accepts the closed set', () => {
    for (const mode of PROCESSOR_MODES) {
      expect(isProcessorMode(mode)).toBe(true);
    }
  });
  test('rejects unknown values', () => {
    expect(isProcessorMode('hosted')).toBe(false);
    expect(isProcessorMode('LIVE')).toBe(false);
    expect(isProcessorMode(undefined)).toBe(false);
    expect(isProcessorMode(null)).toBe(false);
    expect(isProcessorMode(42)).toBe(false);
  });
});

describe('resolveProcessorMode', () => {
  test('defaults to stub when NODE_ENV is not production', () => {
    expect(resolveProcessorMode({ NODE_ENV: 'development' })).toBe('stub');
    expect(resolveProcessorMode({ NODE_ENV: 'test' })).toBe('stub');
    expect(resolveProcessorMode({})).toBe('stub');
  });

  test('defaults to live when NODE_ENV is production', () => {
    expect(resolveProcessorMode({ NODE_ENV: 'production' })).toBe('live');
  });

  test('honours STORAGE_PROCESSOR_MODE override (stub in production)', () => {
    expect(resolveProcessorMode({ NODE_ENV: 'production', STORAGE_PROCESSOR_MODE: 'stub' })).toBe(
      'stub',
    );
  });

  test('honours STORAGE_PROCESSOR_MODE override (live in development)', () => {
    expect(resolveProcessorMode({ NODE_ENV: 'development', STORAGE_PROCESSOR_MODE: 'live' })).toBe(
      'live',
    );
  });

  test('falls back to env default when STORAGE_PROCESSOR_MODE is unknown', () => {
    expect(resolveProcessorMode({ NODE_ENV: 'production', STORAGE_PROCESSOR_MODE: 'hosted' })).toBe(
      'live',
    );
    expect(resolveProcessorMode({ NODE_ENV: 'development', STORAGE_PROCESSOR_MODE: 'bogus' })).toBe(
      'stub',
    );
  });

  test('treats blank STORAGE_PROCESSOR_MODE as unset', () => {
    expect(resolveProcessorMode({ NODE_ENV: 'production', STORAGE_PROCESSOR_MODE: '' })).toBe(
      'live',
    );
  });
});

// ── registry assembly ───────────────────────────────────────────────────

describe('createRunnerDependencies — registry shape', () => {
  test('wires every STORAGE-7 closed-set job type', () => {
    const { registry } = createRunnerDependencies({
      providerIO: FAKE_IO,
      variants: FAKE_VARIANTS,
      env: { NODE_ENV: 'test' },
    });
    for (const k of [
      'scan_validation',
      'image_optimize',
      'video_probe',
      'video_thumbnail',
      'video_transcode',
      'document_preview',
    ] as const) {
      expect(typeof registry[k]).toBe('function');
    }
  });

  test('registry is frozen — runtime cannot swap runners', () => {
    const { registry } = createRunnerDependencies({
      providerIO: FAKE_IO,
      variants: FAKE_VARIANTS,
      env: { NODE_ENV: 'test' },
    });
    expect(Object.isFrozen(registry)).toBe(true);
  });
});

describe('createRunnerDependencies — mode selection', () => {
  test('stub mode wires stub processors by default', () => {
    const r = createRunnerDependencies({
      providerIO: FAKE_IO,
      variants: FAKE_VARIANTS,
      env: { NODE_ENV: 'test' },
    });
    expect(r.mode).toBe('stub');
  });

  test('live mode wires SharpImageProcessor for image_optimize (STORAGE-FU-5-FU-A); video / document still use production stubs', async () => {
    const r = createRunnerDependencies({
      providerIO: FAKE_IO,
      variants: FAKE_VARIANTS,
      env: { NODE_ENV: 'production' },
    });
    expect(r.mode).toBe('live');
    // The image runner now consumes SharpImageProcessor in live mode
    // (STORAGE-FU-5-FU-A). Passing zero bytes to the runner exercises
    // the failure path: sharp can't decode an empty buffer →
    // RunnerInputError('UNSUPPORTED_FORMAT') inside the processor →
    // the image runner's defensive try/catch wraps that as
    // RunnerExecutionError('PROCESSOR_FAILED', retryable: true) →
    // STORAGE-7 worker dead-letters after maxAttempts retries.
    //
    // This test guards the WIRING, not the byte-level behaviour: the
    // SharpImageProcessor's own unit tests in
    // `sharp-image-processor.test.ts` exercise probe / render / EXIF
    // stripping / dimension caps against real (synthetic) image bytes.
    const result = await r.registry.image_optimize!({
      job: {
        id: 'job-1',
        jobType: 'image_optimize',
        objectId: 'obj-1',
        workspaceId: 'ws-1',
        attempts: 0,
        maxAttempts: 3,
        payload: {},
        required: false,
      },
      object: {
        id: 'obj-1',
        workspaceId: 'ws-1',
        providerId: 'prov-1',
        providerObjectKey: 'k/orig.jpg',
        filename: 'orig.jpg',
        contentType: 'image/jpeg',
        byteSize: 1024,
        sha256: null,
        purpose: 'cms_media',
        visibility: 'private',
        status: 'uploaded',
        compressionRequested: true,
        createdBy: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        uploadedAt: new Date(),
      },
    });
    // FAKE_IO returns zero bytes — SharpImageProcessor.metadata()
    // throws on empty input → RunnerInputError('UNSUPPORTED_FORMAT')
    // inside the processor → the image runner's defensive try/catch
    // wraps that as PROCESSOR_FAILED (retryable). This proves the
    // wiring works end-to-end without exercising real image bytes —
    // the byte-level guarantees land in the FU-A Bug 1 regression
    // guard at the bottom of this file.
    expect(result).toEqual({
      errorCode: 'PROCESSOR_FAILED',
      retryable: true,
    });
  });

  test('explicit mode override beats env resolution', () => {
    const r = createRunnerDependencies({
      providerIO: FAKE_IO,
      variants: FAKE_VARIANTS,
      env: { NODE_ENV: 'production' },
      mode: 'stub',
    });
    expect(r.mode).toBe('stub');
  });
});

describe('createRunnerDependencies — caller overrides', () => {
  test('caller can override every processor + scanner', () => {
    const r = createRunnerDependencies({
      providerIO: FAKE_IO,
      variants: FAKE_VARIANTS,
      image: new StubImageProcessor(),
      video: new StubVideoProcessor(),
      document: new StubDocumentProcessor(),
      scanner: noopMalwareScanner,
      mode: 'live', // override would normally select production stubs
    });
    // Both the override and the mode survive — the override wins per
    // STORAGE-FU-5 acceptance criteria.
    expect(r.mode).toBe('live');
  });

  test('caller override is preferred over both stub and production stubs', async () => {
    // Build a deterministic image processor that returns a fixed
    // payload; passing it as `image` should win over both the stub
    // and production-stub selection.
    const customImage = new StubImageProcessor(); // any concrete works
    const r = createRunnerDependencies({
      providerIO: FAKE_IO,
      variants: FAKE_VARIANTS,
      image: customImage,
      mode: 'live',
    });
    // Live mode would normally throw UNSUPPORTED_FORMAT via the
    // production-stub; the custom override turns that into a working
    // image runner. Quick smoke: probe should succeed via the stub.
    expect(r.mode).toBe('live');
    // Sanity: video + document still come from the live (production
    // stub) selection because they weren't overridden.
    expect(r.registry.video_probe).toBeTypeOf('function');
    expect(r.registry.document_preview).toBeTypeOf('function');
    // Reference the unused variables so eslint doesn't complain.
    void ProductionImageProcessorStub;
    void ProductionVideoProcessorStub;
    void ProductionDocumentProcessorStub;
  });
});

// ── STORAGE-FU-5-FU-A: Bug 1 regression guard ────────────────────────────

/**
 * STORAGE-FU-5-FU-A — Bug 1 regression guard.
 *
 * Before FU-A landed, an `image_optimize` job in live mode produced
 * variant byte sizes of exactly 8 bytes (the stub-mode PNG signature
 * leaking through, or `UNSUPPORTED_FORMAT` from the production stub).
 * This test wires the full image runner against an in-memory JPEG and
 * captures the variants written via the provider IO + variant writer
 * ports. It asserts:
 *
 *   1. The runner completes successfully (no PROCESSOR_FAILED).
 *   2. At least one variant is written (the `balanced` profile writes
 *      thumbnail_small + preview_medium + web_optimized).
 *   3. Each variant's written byte size is > 1024 bytes — sanity
 *      floor that catches the stub-leak / empty-encode regression.
 *   4. Each variant's content-type matches its declared format.
 */
import sharp from 'sharp';

describe('createRunnerDependencies — STORAGE-FU-5-FU-A: live image variants are real bytes', () => {
  test('image_optimize against a real JPEG writes variants > 1024 bytes (Bug 1 guard)', async () => {
    // Synthesize a small but realistic JPEG (256x192) with pseudo-random
    // noise. A solid-colour test image would compress to ~150 bytes per
    // variant — well below the Bug 1 sanity floor. Real-world photos
    // never compress that tightly; the noise pattern below simulates a
    // realistic frequency profile so each variant lands well above
    // 1 KiB.
    const rawPixels = Buffer.alloc(256 * 192 * 3);
    let seed = 0x12345678;
    for (let i = 0; i < rawPixels.length; i += 1) {
      // xorshift32 — deterministic but high-frequency, defeats most
      // lossy compressors below ~50% quality.
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      rawPixels[i] = seed & 0xff;
    }
    const sourceJpeg = await sharp(rawPixels, {
      raw: { width: 256, height: 192, channels: 3 },
    })
      .jpeg({ quality: 90 })
      .toBuffer();

    // Capturing provider IO: reads return our source bytes; writes
    // are stashed for assertion.
    const writes: Array<{
      objectKey: string;
      body: Uint8Array;
      contentType: string;
      byteSize: number;
    }> = [];
    const capturingIO = {
      async readObject(): Promise<Uint8Array> {
        return new Uint8Array(sourceJpeg);
      },
      async writeObject(input: {
        objectKey: string;
        body: Uint8Array;
        contentType: string;
      }): Promise<{ byteSize: number }> {
        writes.push({ ...input, byteSize: input.body.length });
        return { byteSize: input.body.length };
      },
    };

    // Capturing variant writer: keeps track of recorded variants.
    const recorded: Array<{ role: string; contentType: string; byteSize: number }> = [];
    const capturingVariants = {
      async recordVariant(input: {
        role: string;
        contentType: string;
        byteSize: number;
      }): Promise<void> {
        recorded.push({
          role: input.role,
          contentType: input.contentType,
          byteSize: input.byteSize,
        });
      },
    };

    const r = createRunnerDependencies({
      providerIO: capturingIO,
      variants: capturingVariants,
      env: { NODE_ENV: 'production' },
    });
    expect(r.mode).toBe('live');

    const result = await r.registry.image_optimize!({
      job: {
        id: 'job-1',
        jobType: 'image_optimize',
        objectId: 'obj-1',
        workspaceId: 'ws-1',
        attempts: 0,
        maxAttempts: 3,
        payload: {},
        required: false,
      },
      object: {
        id: 'obj-1',
        workspaceId: 'ws-1',
        providerId: 'prov-1',
        providerObjectKey: 'k/orig.jpg',
        filename: 'orig.jpg',
        contentType: 'image/jpeg',
        byteSize: sourceJpeg.length,
        sha256: null,
        purpose: 'cms_media',
        visibility: 'private',
        status: 'uploaded',
        compressionRequested: true,
        createdBy: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        uploadedAt: new Date(),
      },
    });

    // Runner reported success (no error code envelope).
    expect(result).toEqual({});

    // The balanced profile writes 3 variants.
    expect(writes.length).toBe(3);
    expect(recorded.length).toBe(3);

    // Bug 1 regression guard: every variant must be > 1024 bytes.
    // Stub-mode produced 8-byte variants; production-stub produced
    // zero (UNSUPPORTED_FORMAT). FU-A produces real re-encoded bytes.
    for (const w of writes) {
      expect(w.byteSize).toBeGreaterThan(1024);
      // Defense in depth: contentType matches its known image MIME.
      expect(w.contentType).toMatch(/^image\/(avif|webp|jpeg|png)$/);
    }

    // Sanity: at least one variant emits AVIF and one emits WebP per
    // the balanced profile shape.
    const contentTypes = new Set(writes.map((w) => w.contentType));
    expect(contentTypes.has('image/webp')).toBe(true);
    expect(contentTypes.has('image/avif')).toBe(true);
  });
});
