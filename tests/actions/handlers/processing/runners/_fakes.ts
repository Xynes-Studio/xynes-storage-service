/**
 * STORAGE-8 — shared test fakes for runner unit tests.
 *
 * Fakes mirror the production DI ports (`ProviderObjectIO`,
 * `ImageProcessor`, `VideoProcessor`, `DocumentProcessor`,
 * `MalwareScanner`, `StorageVariantWriter`). They expose call counters
 * and override hooks so tests stay deterministic.
 *
 * Test data invariants:
 *   - All UUIDs are valid v4-ish strings (`deriveProviderObjectKey`
 *     guard accepts them).
 *   - All bytes are deterministic `Uint8Array`s — NEVER cryptographic
 *     keys, signed URLs, or provider tokens (the runners' redaction
 *     posture is enforced by the worker layer; the fakes still avoid
 *     anything that LOOKS sensitive so a future grep on `xynes_live_`
 *     doesn't false-positive on this file).
 */
import type { ClaimedJob } from '../../../../../src/actions/handlers/processing/types';
import type {
  DocumentPreviewRender,
  DocumentProcessor,
  ImageProbeResult,
  ImageProcessor,
  ImageVariantRender,
  MalwareScanResult,
  MalwareScanner,
  ProviderObjectIO,
  StorageVariantWriter,
  VariantRecord,
  VideoPosterRender,
  VideoProbeResult,
  VideoProcessor,
  VideoTranscodeRender,
} from '../../../../../src/actions/handlers/processing/runners/ports';
import type { ImageVariantSpec } from '../../../../../src/actions/handlers/processing/runners/profiles';
import { seedObject as baseSeedObject, TEST_WORKSPACE_ID } from '../_fakes';
import type { StorageObjectRecord } from '../../../../../src/actions/handlers/objects/types';

export { TEST_WORKSPACE_ID };

export function seedImageObject(overrides: Partial<StorageObjectRecord> = {}): StorageObjectRecord {
  return baseSeedObject({
    contentType: 'image/jpeg',
    compressionRequested: true,
    providerObjectKey: 'workspaces/ws/objects/obj/photo.jpg',
    filename: 'photo.jpg',
    byteSize: 1024 * 1024, // 1 MiB
    ...overrides,
  });
}

export function seedVideoObject(overrides: Partial<StorageObjectRecord> = {}): StorageObjectRecord {
  return baseSeedObject({
    contentType: 'video/mp4',
    compressionRequested: true,
    providerObjectKey: 'workspaces/ws/objects/obj/clip.mp4',
    filename: 'clip.mp4',
    byteSize: 16 * 1024 * 1024, // 16 MiB
    ...overrides,
  });
}

export function seedDocumentObject(
  overrides: Partial<StorageObjectRecord> = {},
): StorageObjectRecord {
  return baseSeedObject({
    contentType: 'application/pdf',
    compressionRequested: true,
    providerObjectKey: 'workspaces/ws/objects/obj/doc.pdf',
    filename: 'doc.pdf',
    byteSize: 512 * 1024,
    ...overrides,
  });
}

export function seedClaimedJob(overrides: Partial<ClaimedJob> = {}): ClaimedJob {
  return {
    id: '00000000-0000-4000-8000-200000000099',
    objectId: '00000000-0000-4000-8000-100000000099',
    workspaceId: TEST_WORKSPACE_ID,
    jobType: 'image_optimize',
    required: false,
    payload: {},
    attempts: 0,
    maxAttempts: 3,
    ...overrides,
  };
}

// ── FakeProviderIO ─────────────────────────────────────────────────────────

export class FakeProviderIO implements ProviderObjectIO {
  /** Map of objectKey -> bytes that `readObject` returns. */
  public readonly stored = new Map<string, { bytes: Uint8Array; contentType: string }>();
  public readCount = 0;
  public writeCount = 0;
  /** Captured write inputs in call order. */
  public writes: Array<{
    objectKey: string;
    body: Uint8Array;
    contentType: string;
    ifAbsent?: boolean;
  }> = [];
  /** If set, the next `readObject` throws this error. */
  public throwOnReadOnce: Error | null = null;
  /** If set, the next `writeObject` throws this error. */
  public throwOnWriteOnce: Error | null = null;

  preload(objectKey: string, bytes: Uint8Array, contentType = 'application/octet-stream'): void {
    this.stored.set(objectKey, { bytes, contentType });
  }

  async readObject(input: { objectKey: string }): Promise<Uint8Array> {
    this.readCount += 1;
    if (this.throwOnReadOnce) {
      const err = this.throwOnReadOnce;
      this.throwOnReadOnce = null;
      throw err;
    }
    const row = this.stored.get(input.objectKey);
    if (!row) {
      throw new Error('FakeProviderIO: no preloaded bytes for ' + input.objectKey);
    }
    return row.bytes;
  }

  async writeObject(input: {
    objectKey: string;
    body: Uint8Array;
    contentType: string;
    ifAbsent?: boolean;
  }): Promise<{ byteSize: number }> {
    this.writeCount += 1;
    this.writes.push({ ...input });
    if (this.throwOnWriteOnce) {
      const err = this.throwOnWriteOnce;
      this.throwOnWriteOnce = null;
      throw err;
    }
    if (input.ifAbsent && this.stored.has(input.objectKey)) {
      throw new Error('FakeProviderIO: object already exists (ifAbsent)');
    }
    this.stored.set(input.objectKey, { bytes: input.body, contentType: input.contentType });
    return { byteSize: input.body.byteLength };
  }
}

// ── FakeVariantWriter ──────────────────────────────────────────────────────

export class FakeVariantWriter implements StorageVariantWriter {
  public records: VariantRecord[] = [];
  public throwOnRecordOnce: Error | null = null;

  async recordVariant(input: VariantRecord): Promise<void> {
    if (this.throwOnRecordOnce) {
      const err = this.throwOnRecordOnce;
      this.throwOnRecordOnce = null;
      throw err;
    }
    this.records.push({ ...input });
  }
}

// ── FakeMalwareScanner ─────────────────────────────────────────────────────

export class FakeMalwareScanner implements MalwareScanner {
  public verdict: MalwareScanResult = { verdict: 'clean' };
  public scanCount = 0;

  async scan(_input: { bytes: Uint8Array }): Promise<MalwareScanResult> {
    this.scanCount += 1;
    return this.verdict;
  }
}

// ── FakeImageProcessor ────────────────────────────────────────────────────

export class FakeImageProcessor implements ImageProcessor {
  public probeResult: ImageProbeResult = {
    width: 4000,
    height: 3000,
    format: 'jpeg',
    hasGpsExif: true,
  };
  public throwOnProbeOnce: Error | null = null;
  public throwOnRenderOnce: Error | null = null;
  /** Captured render specs in call order. */
  public renderCalls: Array<{ bytes: Uint8Array; spec: ImageVariantSpec }> = [];

  async probe(_input: { bytes: Uint8Array }): Promise<ImageProbeResult> {
    if (this.throwOnProbeOnce) {
      const err = this.throwOnProbeOnce;
      this.throwOnProbeOnce = null;
      throw err;
    }
    return this.probeResult;
  }

  async renderVariant(input: {
    bytes: Uint8Array;
    spec: ImageVariantSpec;
  }): Promise<ImageVariantRender> {
    this.renderCalls.push(input);
    if (this.throwOnRenderOnce) {
      const err = this.throwOnRenderOnce;
      this.throwOnRenderOnce = null;
      throw err;
    }
    const contentType = ((): ImageVariantRender['contentType'] => {
      switch (input.spec.format) {
        case 'avif':
          return 'image/avif';
        case 'webp':
          return 'image/webp';
        case 'original':
          return 'image/jpeg';
        case 'jpeg':
        default:
          return 'image/jpeg';
      }
    })();
    const format = ((): ImageVariantRender['format'] => {
      switch (input.spec.format) {
        case 'avif':
          return 'avif';
        case 'webp':
          return 'webp';
        case 'jpeg':
          return 'jpeg';
        case 'original':
          return 'jpeg';
      }
    })();
    return {
      bytes: new Uint8Array([1, 2, 3, 4]),
      width: Math.min(input.spec.maxWidth, this.probeResult.width),
      height: Math.min(input.spec.maxHeight, this.probeResult.height),
      format,
      contentType,
    };
  }
}

// ── FakeVideoProcessor ─────────────────────────────────────────────────────

export class FakeVideoProcessor implements VideoProcessor {
  public probeResult: VideoProbeResult = {
    durationSeconds: 30,
    width: 1280,
    height: 720,
    container: 'mp4',
    videoCodec: 'h264',
    audioCodec: 'aac',
    rotationDegrees: null,
  };
  public throwOnProbeOnce: Error | null = null;
  public throwOnPosterOnce: Error | null = null;
  public throwOnTranscodeOnce: Error | null = null;
  public posterRender: VideoPosterRender = {
    bytes: new Uint8Array([9, 9, 9]),
    width: 640,
    height: 360,
    contentType: 'image/jpeg',
  };
  public transcodeRender: VideoTranscodeRender = {
    bytes: new Uint8Array([8, 8, 8, 8]),
    width: 1280,
    height: 720,
    durationSeconds: 30,
    contentType: 'video/mp4',
  };

  async probe(_input: { bytes: Uint8Array }): Promise<VideoProbeResult> {
    if (this.throwOnProbeOnce) {
      const err = this.throwOnProbeOnce;
      this.throwOnProbeOnce = null;
      throw err;
    }
    return this.probeResult;
  }
  async renderPoster(_input: { bytes: Uint8Array; profile: unknown }): Promise<VideoPosterRender> {
    if (this.throwOnPosterOnce) {
      const err = this.throwOnPosterOnce;
      this.throwOnPosterOnce = null;
      throw err;
    }
    return this.posterRender;
  }
  async renderTranscode(_input: {
    bytes: Uint8Array;
    profile: unknown;
  }): Promise<VideoTranscodeRender> {
    if (this.throwOnTranscodeOnce) {
      const err = this.throwOnTranscodeOnce;
      this.throwOnTranscodeOnce = null;
      throw err;
    }
    return this.transcodeRender;
  }
}

// ── FakeDocumentProcessor ──────────────────────────────────────────────────

export class FakeDocumentProcessor implements DocumentProcessor {
  public render: DocumentPreviewRender = {
    bytes: new Uint8Array([7, 7]),
    contentType: 'image/png',
    width: 1024,
    height: 1448,
  };
  public throwOnceOnce: Error | null = null;

  async renderFirstPagePreview(_input: {
    bytes: Uint8Array;
    sourceContentType: string;
  }): Promise<DocumentPreviewRender> {
    if (this.throwOnceOnce) {
      const err = this.throwOnceOnce;
      this.throwOnceOnce = null;
      throw err;
    }
    return this.render;
  }
}

// ── Convenience: bytes that look like a generic file ─────────────────────

export function makeBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) out[i] = i & 0xff;
  return out;
}
