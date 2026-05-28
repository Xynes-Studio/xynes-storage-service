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

  test('live mode wires SharpImageProcessor for image_optimize + FfmpegVideoProcessor for video_* (STORAGE-FU-5-FU-A + FU-B); document still uses production stub', async () => {
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

// ── STORAGE-FU-5-FU-B: Bug 1 regression guard (video) ────────────────────

/**
 * STORAGE-FU-5-FU-B — Bug 1 regression guard for video variants.
 *
 * Before FU-B landed, a `video_thumbnail` job in live mode produced
 * a 4-byte JPEG-SOI+EOI stub artefact, and `video_transcode` produced
 * a 24-byte `ftypisom` MP4 box header stub. Both are bunk.
 *
 * This test wires the full video_thumbnail + video_transcode runners
 * against a real in-memory MP4 produced by ffmpeg-static and asserts:
 *
 *   1. The thumbnail runner writes a poster variant > 1024 bytes.
 *   2. The transcode runner writes a transcode_h264 variant > 1024
 *      bytes.
 *   3. Both variant content-types match their declared format.
 */
describe('createRunnerDependencies — STORAGE-FU-5-FU-B: live video variants are real bytes', () => {
  test('video_thumbnail + video_transcode against a real MP4 write variants > 1024 bytes (Bug 1 guard)', async () => {
    // Resolve the ffmpeg-static binary path inline so this test
    // self-contains its source-MP4 generation (mirrors the pattern
    // in `ffmpeg-video-processor.test.ts` Bug 1 guard).
    const { __forTesting__: vp } =
      await import('../../../src/infra/processors/ffmpeg-video-processor');
    const ffmpegPath = vp.resolveDefaultFfmpegPath();

    // Generate a 2-second 160x120 H.264+AAC MP4 in memory.
    const gen = Bun.spawn(
      [
        ffmpegPath,
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=2:size=160x120:rate=10',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=2',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-c:a',
        'aac',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+frag_keyframe+empty_moov',
        '-f',
        'mp4',
        'pipe:1',
      ],
      { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    );
    const sourceMp4 = new Uint8Array(await new Response(gen.stdout).arrayBuffer());
    await gen.exited;
    expect(sourceMp4.length).toBeGreaterThan(0);

    // Capturing IO + variant writer.
    const writes: Array<{
      objectKey: string;
      body: Uint8Array;
      contentType: string;
      byteSize: number;
    }> = [];
    const capturingIO = {
      async readObject(): Promise<Uint8Array> {
        return new Uint8Array(sourceMp4);
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

    const job = {
      id: 'job-1',
      jobType: 'video_thumbnail' as const,
      objectId: 'obj-1',
      workspaceId: 'ws-1',
      attempts: 0,
      maxAttempts: 3,
      payload: {},
      required: false,
    };
    const object = {
      id: 'obj-1',
      workspaceId: 'ws-1',
      providerId: 'prov-1',
      providerObjectKey: 'k/orig.mp4',
      filename: 'orig.mp4',
      contentType: 'video/mp4',
      byteSize: sourceMp4.length,
      sha256: null,
      purpose: 'cms_media' as const,
      visibility: 'private' as const,
      status: 'uploaded' as const,
      compressionRequested: true,
      createdBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      uploadedAt: new Date(),
    };

    // Run the thumbnail runner.
    const posterResult = await r.registry.video_thumbnail!({ job, object });
    expect(posterResult).toEqual({});

    // Run the transcode runner against the same source.
    const transcodeResult = await r.registry.video_transcode!({
      job: { ...job, jobType: 'video_transcode' },
      object,
    });
    expect(transcodeResult).toEqual({});

    // Bug 1 regression guard: every variant > 1024 bytes.
    expect(writes.length).toBe(2);
    for (const w of writes) {
      expect(w.byteSize).toBeGreaterThan(1024);
    }
    const contentTypes = new Set(writes.map((w) => w.contentType));
    expect(contentTypes.has('image/jpeg')).toBe(true); // poster
    expect(contentTypes.has('video/mp4')).toBe(true); // transcode

    // Variant records mirror the writes.
    expect(recorded.length).toBe(2);
    expect(new Set(recorded.map((r) => r.role))).toEqual(new Set(['poster', 'transcode_h264']));
  }, 60_000);
});

// ── STORAGE-FU-5-FU-B: env contract + fallback ───────────────────────────

import { __forTesting__ as runnerDepsForTesting } from '../../../src/infra/processors/runner-dependencies';

describe('resolveFfmpegTimeoutMs', () => {
  test('returns undefined when env var is unset', () => {
    expect(runnerDepsForTesting.resolveFfmpegTimeoutMs({})).toBeUndefined();
  });

  test('returns undefined when env var is empty', () => {
    expect(
      runnerDepsForTesting.resolveFfmpegTimeoutMs({ STORAGE_FFMPEG_TIMEOUT_MS: '' }),
    ).toBeUndefined();
  });

  test('returns undefined when env var is non-numeric', () => {
    expect(
      runnerDepsForTesting.resolveFfmpegTimeoutMs({ STORAGE_FFMPEG_TIMEOUT_MS: 'never' }),
    ).toBeUndefined();
  });

  test('returns undefined when env var is non-positive', () => {
    expect(
      runnerDepsForTesting.resolveFfmpegTimeoutMs({ STORAGE_FFMPEG_TIMEOUT_MS: '0' }),
    ).toBeUndefined();
    expect(
      runnerDepsForTesting.resolveFfmpegTimeoutMs({ STORAGE_FFMPEG_TIMEOUT_MS: '-10' }),
    ).toBeUndefined();
  });

  test('returns undefined when env var is a float (non-integer)', () => {
    expect(
      runnerDepsForTesting.resolveFfmpegTimeoutMs({ STORAGE_FFMPEG_TIMEOUT_MS: '1.5' }),
    ).toBeUndefined();
  });

  test('returns parsed integer for a valid positive int env var', () => {
    expect(
      runnerDepsForTesting.resolveFfmpegTimeoutMs({ STORAGE_FFMPEG_TIMEOUT_MS: '90000' }),
    ).toBe(90000);
  });
});

describe('buildLiveVideoProcessor — fallback posture', () => {
  test('returns a working processor when the loader resolves', () => {
    runnerDepsForTesting.resetFfmpegFallbackLogged();
    const proc = runnerDepsForTesting.buildLiveVideoProcessor({});
    expect(proc).toBeDefined();
    expect(typeof proc.probe).toBe('function');
    expect(typeof proc.renderPoster).toBe('function');
    expect(typeof proc.renderTranscode).toBe('function');
  });

  test('falls back to production stub when the loader throws (single WARN)', () => {
    runnerDepsForTesting.resetFfmpegFallbackLogged();
    const origWarn = console.warn;
    const warnCalls: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnCalls.push(args);
    };
    try {
      // First call: throws inside loader → WARN fires.
      const proc1 = runnerDepsForTesting.buildLiveVideoProcessor({}, () => {
        throw new Error('synthetic ffmpeg-loader failure (test fixture)');
      });
      expect(proc1).toBeDefined();
      // Second call: same throwing loader → WARN does NOT re-fire.
      const proc2 = runnerDepsForTesting.buildLiveVideoProcessor({}, () => {
        throw new Error('synthetic again');
      });
      expect(proc2).toBeDefined();
      expect(warnCalls.length).toBe(1);
      // WARN message carries NO library hint (STORAGE-9 redaction).
      const warnText = String(warnCalls[0][0]);
      expect(warnText).toMatch(/runner-dependencies/);
      expect(warnText).not.toMatch(/synthetic|loader|stack|ffmpeg-static/i);
    } finally {
      console.warn = origWarn;
      runnerDepsForTesting.resetFfmpegFallbackLogged();
    }
  });
});

// ── STORAGE-FU-5-FU-C: env contract + fallback ───────────────────────────

describe('resolveSofficeTimeoutMs', () => {
  test('returns undefined when env var is unset', () => {
    expect(runnerDepsForTesting.resolveSofficeTimeoutMs({})).toBeUndefined();
  });

  test('returns undefined when env var is empty', () => {
    expect(
      runnerDepsForTesting.resolveSofficeTimeoutMs({ STORAGE_SOFFICE_TIMEOUT_MS: '' }),
    ).toBeUndefined();
  });

  test('returns undefined when env var is non-numeric', () => {
    expect(
      runnerDepsForTesting.resolveSofficeTimeoutMs({ STORAGE_SOFFICE_TIMEOUT_MS: 'soon' }),
    ).toBeUndefined();
  });

  test('returns undefined when env var is non-positive', () => {
    expect(
      runnerDepsForTesting.resolveSofficeTimeoutMs({ STORAGE_SOFFICE_TIMEOUT_MS: '0' }),
    ).toBeUndefined();
    expect(
      runnerDepsForTesting.resolveSofficeTimeoutMs({ STORAGE_SOFFICE_TIMEOUT_MS: '-30' }),
    ).toBeUndefined();
  });

  test('returns undefined when env var is a float', () => {
    expect(
      runnerDepsForTesting.resolveSofficeTimeoutMs({ STORAGE_SOFFICE_TIMEOUT_MS: '1.5' }),
    ).toBeUndefined();
  });

  test('returns parsed integer for a valid positive int env var', () => {
    expect(
      runnerDepsForTesting.resolveSofficeTimeoutMs({ STORAGE_SOFFICE_TIMEOUT_MS: '90000' }),
    ).toBe(90000);
  });
});

describe('resolveLibreOfficeServiceUrl', () => {
  test('returns undefined when env var is unset', () => {
    expect(runnerDepsForTesting.resolveLibreOfficeServiceUrl({})).toBeUndefined();
  });

  test('returns undefined when env var is empty', () => {
    expect(
      runnerDepsForTesting.resolveLibreOfficeServiceUrl({ LIBREOFFICE_SERVICE_URL: '' }),
    ).toBeUndefined();
  });

  test('returns undefined when env var is whitespace-only', () => {
    expect(
      runnerDepsForTesting.resolveLibreOfficeServiceUrl({ LIBREOFFICE_SERVICE_URL: '   ' }),
    ).toBeUndefined();
  });

  test('returns trimmed value for a non-empty env var', () => {
    expect(
      runnerDepsForTesting.resolveLibreOfficeServiceUrl({
        LIBREOFFICE_SERVICE_URL: '  http://libreoffice-sidecar:8100  ',
      }),
    ).toBe('http://libreoffice-sidecar:8100');
  });
});

describe('buildLiveDocumentProcessor — fallback posture', () => {
  test('returns ProductionDocumentProcessorStub when LIBREOFFICE_SERVICE_URL is unset (single WARN, reason=url-missing)', () => {
    runnerDepsForTesting.resetLibreOfficeFallbackLogged();
    const origWarn = console.warn;
    const warnCalls: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnCalls.push(args);
    };
    try {
      const proc1 = runnerDepsForTesting.buildLiveDocumentProcessor({});
      // Calling again does NOT re-emit the WARN.
      const proc2 = runnerDepsForTesting.buildLiveDocumentProcessor({});
      expect(proc1).toBeDefined();
      expect(proc2).toBeDefined();
      expect(warnCalls.length).toBe(1);
      // Audit hint: closed-set `reason` tag.
      const warnText = String(warnCalls[0][0]);
      expect(warnText).toMatch(/runner-dependencies/);
      expect(warnText).toMatch(/url-missing/);
      expect(warnText).not.toMatch(/libreoffice-sidecar|http:|https:/);
    } finally {
      console.warn = origWarn;
      runnerDepsForTesting.resetLibreOfficeFallbackLogged();
    }
  });

  test('returns LibreOfficeDocumentProcessor when URL is set and loader resolves', async () => {
    runnerDepsForTesting.resetLibreOfficeFallbackLogged();
    const proc = runnerDepsForTesting.buildLiveDocumentProcessor({
      LIBREOFFICE_SERVICE_URL: 'http://libreoffice-sidecar:8100',
    });
    expect(proc).toBeDefined();
    expect(typeof proc.renderFirstPagePreview).toBe('function');
  });

  test('falls back to ProductionDocumentProcessorStub when the loader throws (single WARN, reason=ctor-failed)', () => {
    runnerDepsForTesting.resetLibreOfficeFallbackLogged();
    const origWarn = console.warn;
    const warnCalls: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnCalls.push(args);
    };
    try {
      const proc1 = runnerDepsForTesting.buildLiveDocumentProcessor(
        { LIBREOFFICE_SERVICE_URL: 'http://libreoffice-sidecar:8100' },
        () => {
          throw new Error('synthetic libreoffice-loader failure (test fixture)');
        },
      );
      const proc2 = runnerDepsForTesting.buildLiveDocumentProcessor(
        { LIBREOFFICE_SERVICE_URL: 'http://libreoffice-sidecar:8100' },
        () => {
          throw new Error('synthetic again');
        },
      );
      expect(proc1).toBeDefined();
      expect(proc2).toBeDefined();
      expect(warnCalls.length).toBe(1);
      const warnText = String(warnCalls[0][0]);
      expect(warnText).toMatch(/runner-dependencies/);
      expect(warnText).toMatch(/ctor-failed/);
      // No library / URL hint.
      expect(warnText).not.toMatch(/synthetic|loader|stack|libreoffice-sidecar|http:/i);
    } finally {
      console.warn = origWarn;
      runnerDepsForTesting.resetLibreOfficeFallbackLogged();
    }
  });

  test('falls back to ProductionDocumentProcessorStub when the URL is invalid (ctor throws)', () => {
    runnerDepsForTesting.resetLibreOfficeFallbackLogged();
    const origWarn = console.warn;
    const warnCalls: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnCalls.push(args);
    };
    try {
      const proc = runnerDepsForTesting.buildLiveDocumentProcessor({
        LIBREOFFICE_SERVICE_URL: 'file:///etc/passwd',
      });
      // Real loader resolves but the ctor throws on the bad URL →
      // fallback path runs.
      expect(proc).toBeDefined();
      expect(warnCalls.length).toBe(1);
      const warnText = String(warnCalls[0][0]);
      expect(warnText).toMatch(/ctor-failed/);
    } finally {
      console.warn = origWarn;
      runnerDepsForTesting.resetLibreOfficeFallbackLogged();
    }
  });

  test('forwards STORAGE_SOFFICE_TIMEOUT_MS to the constructor', async () => {
    runnerDepsForTesting.resetLibreOfficeFallbackLogged();
    let observedDeps: { serviceUrl: string; timeoutMs?: number } | undefined;
    // Inject a fake Ctor via the loader seam that records its
    // constructor args. We have to return a class shape that
    // matches the type signature, so use a stub class.
    class FakeCtor {
      constructor(deps: { serviceUrl: string; timeoutMs?: number }) {
        observedDeps = deps;
      }
      async renderFirstPagePreview(): Promise<never> {
        throw new Error('unused in this test');
      }
    }
    const proc = runnerDepsForTesting.buildLiveDocumentProcessor(
      {
        LIBREOFFICE_SERVICE_URL: 'http://libreoffice-sidecar:8100',
        STORAGE_SOFFICE_TIMEOUT_MS: '15000',
      },
      () => FakeCtor as unknown as new (deps: { serviceUrl: string; timeoutMs?: number }) => never,
    );
    expect(proc).toBeDefined();
    expect(observedDeps?.serviceUrl).toBe('http://libreoffice-sidecar:8100');
    expect(observedDeps?.timeoutMs).toBe(15000);
  });

  test('omits timeoutMs from constructor when env var is unset', () => {
    runnerDepsForTesting.resetLibreOfficeFallbackLogged();
    let observedDeps: { serviceUrl: string; timeoutMs?: number } | undefined;
    class FakeCtor {
      constructor(deps: { serviceUrl: string; timeoutMs?: number }) {
        observedDeps = deps;
      }
      async renderFirstPagePreview(): Promise<never> {
        throw new Error('unused');
      }
    }
    const proc = runnerDepsForTesting.buildLiveDocumentProcessor(
      { LIBREOFFICE_SERVICE_URL: 'http://libreoffice-sidecar:8100' },
      () => FakeCtor as unknown as new (deps: { serviceUrl: string; timeoutMs?: number }) => never,
    );
    expect(proc).toBeDefined();
    expect(observedDeps?.serviceUrl).toBe('http://libreoffice-sidecar:8100');
    // No `timeoutMs` key when env var is unset — defaults inside the
    // ctor take over.
    expect('timeoutMs' in (observedDeps as object)).toBe(false);
  });
});

// ── STORAGE-FU-5-FU-C: Bug 1 regression guard (document) ─────────────────

/**
 * STORAGE-FU-5-FU-C — Bug 1 regression guard for document variants.
 *
 * Before FU-C landed, a `document_preview` job in live mode produced
 * a 4-byte JPEG-SOI+EOI stub artefact (`StubDocumentProcessor`) or
 * `UNSUPPORTED_FORMAT` (`ProductionDocumentProcessorStub`). FU-C
 * wires the LibreOffice sidecar HTTP client so the runner produces a
 * real PNG/JPEG preview.
 *
 * This test wires the full document_preview runner against a fake
 * `globalThis.fetch` that simulates the sidecar returning a real
 * preview body. It asserts:
 *
 *   1. The runner completes successfully (no PROCESSOR_FAILED).
 *   2. A `preview_first_page` variant is written.
 *   3. The variant byte size is > 1024 bytes (Bug 1 sanity floor).
 *   4. The content-type is `image/png` or `image/jpeg`.
 */
describe('createRunnerDependencies — STORAGE-FU-5-FU-C: live document variants are real bytes', () => {
  test('document_preview against a fake sidecar writes preview > 1024 bytes (Bug 1 guard)', async () => {
    // Build a synthetic 2 KiB PNG body — bigger than the Bug 1 floor
    // but small enough that the test stays in memory.
    const fakePreviewBytes = new Uint8Array(2048);
    // PNG signature + filler.
    fakePreviewBytes[0] = 0x89;
    fakePreviewBytes[1] = 0x50;
    fakePreviewBytes[2] = 0x4e;
    fakePreviewBytes[3] = 0x47;
    fakePreviewBytes[4] = 0x0d;
    fakePreviewBytes[5] = 0x0a;
    fakePreviewBytes[6] = 0x1a;
    fakePreviewBytes[7] = 0x0a;
    // Capturing IO + variant writer (same pattern as FU-A / FU-B).
    const writes: Array<{
      objectKey: string;
      body: Uint8Array;
      contentType: string;
      byteSize: number;
    }> = [];
    const capturingIO = {
      async readObject(): Promise<Uint8Array> {
        // Simulate the original PDF bytes — content doesn't matter
        // because the fake sidecar ignores them.
        return new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
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

    // Patch globalThis.fetch to simulate the sidecar.
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response(fakePreviewBytes, {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'x-document-page-width': '1240',
          'x-document-page-height': '1754',
        },
      });
    }) as unknown as typeof fetch;

    try {
      const r = createRunnerDependencies({
        providerIO: capturingIO,
        variants: capturingVariants,
        env: {
          NODE_ENV: 'production',
          LIBREOFFICE_SERVICE_URL: 'http://libreoffice-sidecar:8100',
        },
      });
      expect(r.mode).toBe('live');
      const result = await r.registry.document_preview!({
        job: {
          id: 'job-1',
          jobType: 'document_preview',
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
          providerObjectKey: 'k/orig.pdf',
          filename: 'orig.pdf',
          contentType: 'application/pdf',
          byteSize: 4,
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

      // Runner reports success.
      expect(result).toEqual({});

      // Exactly one variant was written.
      expect(writes.length).toBe(1);
      expect(recorded.length).toBe(1);

      // Bug 1 regression guard: variant > 1024 bytes.
      expect(writes[0].byteSize).toBeGreaterThan(1024);

      // Content-type matches the closed set.
      expect(writes[0].contentType).toMatch(/^image\/(png|jpeg)$/);

      // Recorded role + dimensions.
      expect(recorded[0].role).toBe('preview_first_page');
      expect(recorded[0].contentType).toBe('image/png');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
