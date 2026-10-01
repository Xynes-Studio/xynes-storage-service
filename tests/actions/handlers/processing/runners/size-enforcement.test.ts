import { describe, expect, test } from 'bun:test';
import { createImageOptimizeRunner } from '../../../../../src/actions/handlers/processing/runners/image';
import { createDocumentPreviewRunner } from '../../../../../src/actions/handlers/processing/runners/document';
import { createScanValidationRunner } from '../../../../../src/actions/handlers/processing/runners/scan-validation';
import {
  createVideoProbeRunner,
  createVideoThumbnailRunner,
  createVideoTranscodeRunner,
} from '../../../../../src/actions/handlers/processing/runners/video';
import type { ProviderObjectIO } from '../../../../../src/actions/handlers/processing/runners/ports';
import type { JobRunner } from '../../../../../src/actions/handlers/processing/types';
import { ProviderAdapterError } from '../../../../../src/infra/providers/errors';
import {
  FakeDocumentProcessor,
  FakeImageProcessor,
  FakeVideoProcessor,
  FakeMalwareScanner,
  FakeVariantWriter,
  seedImageObject,
  seedDocumentObject,
  seedVideoObject,
  seedClaimedJob,
} from './_fakes';

describe('XYN-SEC-002 — processing input integrity', () => {
  for (const kind of [
    'image',
    'document',
    'scan',
    'video_probe',
    'video_thumbnail',
    'video_transcode',
  ] as const) {
    for (const actual of [3, 4, 5]) {
      test(`${kind}: actual length ${actual} is checked before native/scanner work`, async () => {
        let invoked = false;
        let readInput: Parameters<ProviderObjectIO['readObject']>[0] | undefined;
        const providerIO: ProviderObjectIO = {
          async readObject(input) {
            readInput = input;
            return new Uint8Array(actual);
          },
          async writeObject(input) {
            return { byteSize: input.body.byteLength };
          },
        };
        const variants = new FakeVariantWriter();
        const image = new FakeImageProcessor();
        image.probe = async () => {
          invoked = true;
          return image.probeResult;
        };
        const document = new FakeDocumentProcessor();
        const renderDocument = document.renderFirstPagePreview.bind(document);
        document.renderFirstPagePreview = async (input) => {
          invoked = true;
          return renderDocument(input);
        };
        const video = new FakeVideoProcessor();
        video.probe = async () => {
          invoked = true;
          return video.probeResult;
        };
        const poster = video.renderPoster.bind(video);
        video.renderPoster = async (input) => {
          invoked = true;
          return poster(input);
        };
        const transcode = video.renderTranscode.bind(video);
        video.renderTranscode = async (input) => {
          invoked = true;
          return transcode(input);
        };
        const scanner = new FakeMalwareScanner();
        scanner.scan = async () => {
          invoked = true;
          return { verdict: 'clean' };
        };
        const runners: Record<typeof kind, JobRunner> = {
          image: createImageOptimizeRunner({ providerIO, processor: image, variants }),
          document: createDocumentPreviewRunner({ providerIO, processor: document, variants }),
          scan: createScanValidationRunner({ providerIO, scanner }),
          video_probe: createVideoProbeRunner({ providerIO, processor: video }),
          video_thumbnail: createVideoThumbnailRunner({ providerIO, processor: video, variants }),
          video_transcode: createVideoTranscodeRunner({ providerIO, processor: video, variants }),
        };
        const object = kind.startsWith('video')
          ? seedVideoObject({ byteSize: 4 })
          : kind === 'document'
            ? seedDocumentObject({ byteSize: 4 })
            : seedImageObject({ byteSize: 4 });
        const result = await runners[kind]({ object, job: seedClaimedJob() });
        expect(result).toEqual(
          actual === 4 ? {} : { errorCode: 'PROFILE_GUARD_REJECTED', retryable: false },
        );
        expect(invoked).toBe(actual === 4);
        expect(readInput).toMatchObject({
          maxBytes: 4,
          expectedByteSize: 4,
          workspaceId: object.workspaceId,
          providerId: object.providerId,
        });
      });
    }
  }
  for (const [code, errorCode] of [
    ['PROVIDER_OBJECT_TOO_LARGE', 'OVER_MAX_BYTES'],
    ['PROVIDER_OBJECT_SIZE_MISMATCH', 'PROFILE_GUARD_REJECTED'],
    ['PROVIDER_OPERATION_FAILED', 'PROCESSOR_FAILED'],
  ] as const) {
    test(`provider ${code} maps to safe ${errorCode}`, async () => {
      const scanner = new FakeMalwareScanner();
      const providerIO: ProviderObjectIO = {
        async readObject() {
          throw new ProviderAdapterError(code);
        },
        async writeObject() {
          throw new Error('unused');
        },
      };
      const runner = createScanValidationRunner({ providerIO, scanner });
      expect(
        await runner({ object: seedImageObject({ byteSize: 4 }), job: seedClaimedJob() }),
      ).toEqual({ errorCode, retryable: code === 'PROVIDER_OPERATION_FAILED' });
      expect(scanner.scanCount).toBe(0);
    });
  }
  test('a legacy image with under-declared bytes cannot reach the image decoder', async () => {
    const image = new FakeImageProcessor();
    let probed = false;
    image.probe = async () => {
      probed = true;
      return image.probeResult;
    };
    const providerIO: ProviderObjectIO = {
      async readObject() {
        return new Uint8Array(50 * 1024 * 1024 + 1);
      },
      async writeObject() {
        throw new Error('unused');
      },
    };
    const runner = createImageOptimizeRunner({
      providerIO,
      processor: image,
      variants: new FakeVariantWriter(),
    });
    expect(
      await runner({ object: seedImageObject({ byteSize: 4 }), job: seedClaimedJob() }),
    ).toEqual({ errorCode: 'OVER_MAX_BYTES', retryable: false });
    expect(probed).toBe(false);
  });
});

describe('XYN-SEC-002 — stored-size validation and cap boundaries', () => {
  for (const byteSize of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    test(`invalid stored size ${byteSize} fails before provider I/O`, async () => {
      let read = false;
      const providerIO: ProviderObjectIO = {
        async readObject() {
          read = true;
          return new Uint8Array();
        },
        async writeObject() {
          throw new Error('unused');
        },
      };
      const runner = createScanValidationRunner({ providerIO, scanner: new FakeMalwareScanner() });
      expect(
        await runner({ object: seedImageObject({ byteSize }), job: seedClaimedJob() }),
      ).toEqual({ errorCode: 'PROFILE_GUARD_REJECTED', retryable: false });
      expect(read).toBe(false);
    });
  }
  for (const [contentType, cap] of [
    ['image/jpeg', 50 * 1024 * 1024],
    ['video/mp4', 64 * 1024 * 1024],
    ['application/pdf', 64 * 1024 * 1024],
    ['audio/mpeg', 64 * 1024 * 1024],
  ] as const) {
    test(`${contentType}: policy boundary is inclusive, exceeding it avoids I/O`, async () => {
      let read = false;
      const providerIO: ProviderObjectIO = {
        async readObject(input) {
          read = true;
          expect(input).toMatchObject({ maxBytes: cap, expectedByteSize: cap });
          throw new ProviderAdapterError('PROVIDER_OPERATION_FAILED');
        },
        async writeObject() {
          throw new Error('unused');
        },
      };
      const runner = createScanValidationRunner({ providerIO, scanner: new FakeMalwareScanner() });
      expect(
        await runner({
          object: seedImageObject({ contentType, byteSize: cap }),
          job: seedClaimedJob(),
        }),
      ).toEqual({ errorCode: 'PROCESSOR_FAILED', retryable: true });
      expect(read).toBe(true);
      read = false;
      expect(
        await runner({
          object: seedImageObject({ contentType, byteSize: cap + 1 }),
          job: seedClaimedJob(),
        }),
      ).toEqual({ errorCode: 'OVER_MAX_BYTES', retryable: false });
      expect(read).toBe(false);
    });
  }
});

test('parameterized archive MIME types retain the scanner input cap', async () => {
  const { maxBytesForContentType, MAX_SCANNER_INPUT_BYTES } =
    await import('../../../../../src/actions/handlers/objects/byte-size-policy');
  for (const mime of [
    'application/zip;charset=utf-8',
    'application/zstd',
    'application/x-lzma',
    'application/x-cpio',
    'application/x-iso9660-image',
    'application/vnd.ms-cab-compressed',
    'application/x-apple-diskimage',
  ]) {
    expect(maxBytesForContentType(mime)).toBe(MAX_SCANNER_INPUT_BYTES);
  }
});
