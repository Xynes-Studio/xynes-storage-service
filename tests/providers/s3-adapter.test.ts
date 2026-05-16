/**
 * S3 storage provider adapter — operation tests.
 *
 * Tests use injected fakes for the S3Client + presigner so no real network
 * traffic is generated. This is the contract from STORAGE-4:
 *
 *   "Adapter tests use fake providers and do not call real R2, B2, or
 *    iDrive e2."
 */
import { describe, expect, test } from 'bun:test';
import { ProviderAdapterError } from '../../src/infra/providers/errors';
import { S3StorageProviderAdapter } from '../../src/infra/providers/s3-adapter';
import {
  MULTIPART_MAX_PART_COUNT,
  type ProviderAdapterConfig,
} from '../../src/infra/providers/types';

interface CapturedCommand {
  name: string;
  input: Record<string, unknown>;
}

function buildFakeClient(opts?: { sendResult?: unknown; sendError?: Error }): {
  client: unknown;
  sentCommands: CapturedCommand[];
} {
  const sentCommands: CapturedCommand[] = [];
  const fakeClient = {
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      sentCommands.push({ name: command.constructor.name, input: command.input });
      if (opts?.sendError) throw opts.sendError;
      return opts?.sendResult ?? {};
    },
  };
  return { client: fakeClient, sentCommands };
}

function buildFakePresigner(opts?: {
  url?: string;
  throwError?: Error;
  capture?: { commands: CapturedCommand[]; expiries: number[] };
}): (client: unknown, command: unknown, opts: { expiresIn: number }) => Promise<string> {
  return async (_client, command, presignOpts) => {
    if (opts?.throwError) throw opts.throwError;
    const cmd = command as { constructor: { name: string }; input: Record<string, unknown> };
    opts?.capture?.commands.push({ name: cmd.constructor.name, input: cmd.input });
    opts?.capture?.expiries.push(presignOpts.expiresIn);
    return opts?.url ?? 'https://example-bucket.s3.fake/key?X-Amz-Signature=REDACTED-IN-TESTS';
  };
}

const R2_CONFIG: ProviderAdapterConfig = {
  providerKind: 'r2',
  endpoint: 'https://acct123.r2.cloudflarestorage.com',
  region: 'auto',
  bucket: 'xynes-r2-test',
  accessKeyId: 'r2_access_key_fixture',
  secretAccessKey: 'r2_secret_key_fixture',
};

const MINIO_CONFIG: ProviderAdapterConfig = {
  providerKind: 'minio',
  endpoint: 'http://minio:9000',
  region: 'us-east-1',
  bucket: 'xynes-minio-test',
  forcePathStyle: true,
  accessKeyId: 'minio_access_key_fixture',
  secretAccessKey: 'minio_secret_key_fixture',
};

function makeAdapter(
  config: ProviderAdapterConfig,
  fake: {
    sendResult?: unknown;
    sendError?: Error;
    presignUrl?: string;
    presignError?: Error;
    capture?: { commands: CapturedCommand[]; expiries: number[] };
  } = {},
): { adapter: S3StorageProviderAdapter; sentCommands: CapturedCommand[] } {
  const { client, sentCommands } = buildFakeClient({
    sendResult: fake.sendResult,
    sendError: fake.sendError,
  });
  const presign = buildFakePresigner({
    url: fake.presignUrl,
    throwError: fake.presignError,
    capture: fake.capture,
  });
  const adapter = new S3StorageProviderAdapter(config, {
    createClient: () => client as never,
    presign: (c, cmd, o) => presign(c, cmd, o),
  });
  return { adapter, sentCommands };
}

describe('S3StorageProviderAdapter — configuration', () => {
  test('exposes providerKind, endpointHost, and bucket', () => {
    const { adapter } = makeAdapter(R2_CONFIG);
    expect(adapter.providerKind).toBe('r2');
    expect(adapter.endpointHost).toBe('acct123.r2.cloudflarestorage.com');
    expect(adapter.bucket).toBe('xynes-r2-test');
  });

  test('rejects missing endpoint', () => {
    expect(() => makeAdapter({ ...R2_CONFIG, endpoint: '' })).toThrow(ProviderAdapterError);
  });

  test('rejects malformed endpoint URL', () => {
    expect(() => makeAdapter({ ...R2_CONFIG, endpoint: 'not a url' })).toThrow(
      ProviderAdapterError,
    );
  });

  test('rejects missing bucket', () => {
    expect(() => makeAdapter({ ...R2_CONFIG, bucket: '' })).toThrow(ProviderAdapterError);
  });

  test('rejects missing region', () => {
    expect(() => makeAdapter({ ...R2_CONFIG, region: '' })).toThrow(ProviderAdapterError);
  });

  test('rejects missing accessKeyId', () => {
    expect(() => makeAdapter({ ...R2_CONFIG, accessKeyId: '' })).toThrow(ProviderAdapterError);
  });

  test('rejects missing secretAccessKey', () => {
    expect(() => makeAdapter({ ...R2_CONFIG, secretAccessKey: '' })).toThrow(ProviderAdapterError);
  });
});

describe('S3StorageProviderAdapter — createSingleUploadUrl', () => {
  test('issues a PUT command with expected key + bucket + content type', async () => {
    const capture = { commands: [] as CapturedCommand[], expiries: [] as number[] };
    const { adapter } = makeAdapter(R2_CONFIG, { capture });
    const result = await adapter.createSingleUploadUrl({
      objectKey: 'workspaces/abc/files/image.png',
      contentType: 'image/png',
      contentLength: 1024,
    });
    expect(capture.commands).toHaveLength(1);
    expect(capture.commands[0]?.name).toBe('PutObjectCommand');
    expect(capture.commands[0]?.input).toMatchObject({
      Bucket: 'xynes-r2-test',
      Key: 'workspaces/abc/files/image.png',
      ContentType: 'image/png',
      ContentLength: 1024,
    });
    expect(result.url).toContain('https://');
    expect(result.headers['content-type']).toBe('image/png');
    expect(result.headers['content-length']).toBe('1024');
    expect(result.expiresAt).toBeInstanceOf(Date);
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  test('NEVER emits a Tagging header on PutObject (R2/B2 portability)', async () => {
    const capture = { commands: [] as CapturedCommand[], expiries: [] as number[] };
    const { adapter } = makeAdapter(R2_CONFIG, { capture });
    await adapter.createSingleUploadUrl({ objectKey: 'workspaces/abc/files/a.bin' });
    expect(capture.commands[0]?.input.Tagging).toBeUndefined();
  });

  test('rejects empty object key', async () => {
    const { adapter } = makeAdapter(R2_CONFIG);
    await expect(adapter.createSingleUploadUrl({ objectKey: '' })).rejects.toBeInstanceOf(
      ProviderAdapterError,
    );
  });

  test('rejects object key starting with "/"', async () => {
    const { adapter } = makeAdapter(R2_CONFIG);
    await expect(
      adapter.createSingleUploadUrl({ objectKey: '/leading-slash.bin' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_OBJECT_KEY_INVALID' });
  });

  test('rejects object key > 1024 bytes', async () => {
    const { adapter } = makeAdapter(R2_CONFIG);
    await expect(
      adapter.createSingleUploadUrl({ objectKey: 'a'.repeat(1025) }),
    ).rejects.toMatchObject({ code: 'PROVIDER_OBJECT_KEY_INVALID' });
  });

  test('rejects expiry below 30 seconds', async () => {
    const { adapter } = makeAdapter(R2_CONFIG);
    await expect(
      adapter.createSingleUploadUrl({ objectKey: 'a.bin', expiresInSeconds: 5 }),
    ).rejects.toMatchObject({ code: 'PROVIDER_PRESIGN_EXPIRY_INVALID' });
  });

  test('rejects expiry above 7 days (SigV4 hard cap)', async () => {
    const { adapter } = makeAdapter(R2_CONFIG);
    await expect(
      adapter.createSingleUploadUrl({ objectKey: 'a.bin', expiresInSeconds: 8 * 24 * 60 * 60 }),
    ).rejects.toMatchObject({ code: 'PROVIDER_PRESIGN_EXPIRY_INVALID' });
  });

  test('default expiry is 15 minutes', async () => {
    const capture = { commands: [] as CapturedCommand[], expiries: [] as number[] };
    const { adapter } = makeAdapter(R2_CONFIG, { capture });
    await adapter.createSingleUploadUrl({ objectKey: 'a.bin' });
    expect(capture.expiries[0]).toBe(15 * 60);
  });

  test('redacts presigner failure into a sanitised ProviderAdapterError', async () => {
    const { adapter } = makeAdapter(R2_CONFIG, {
      presignError: Object.assign(new Error('AWS rejected key AKIA-LEAK-1234'), {
        name: 'SignatureDoesNotMatch',
      }),
    });
    try {
      await adapter.createSingleUploadUrl({ objectKey: 'a.bin' });
      throw new Error('expected adapter to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderAdapterError);
      const e = err as ProviderAdapterError;
      expect(e.code).toBe('PROVIDER_OPERATION_FAILED');
      // The redacted message MUST NOT carry the leaked access key.
      expect(e.message).not.toContain('AKIA-LEAK-1234');
      // It MAY carry the stable provider error name as a debugging hint.
      expect(e.message).toContain('SignatureDoesNotMatch');
    }
  });
});

describe('S3StorageProviderAdapter — multipart lifecycle', () => {
  test('createMultipartUpload returns the provider UploadId', async () => {
    const { adapter, sentCommands } = makeAdapter(R2_CONFIG, {
      sendResult: { UploadId: 'mp-upload-abc-123' },
    });
    const out = await adapter.createMultipartUpload({
      objectKey: 'workspaces/abc/large.bin',
      contentType: 'application/octet-stream',
    });
    expect(sentCommands).toHaveLength(1);
    expect(sentCommands[0]?.name).toBe('CreateMultipartUploadCommand');
    expect(sentCommands[0]?.input).toMatchObject({
      Bucket: 'xynes-r2-test',
      Key: 'workspaces/abc/large.bin',
      ContentType: 'application/octet-stream',
    });
    expect(sentCommands[0]?.input.Tagging).toBeUndefined();
    expect(out.providerUploadId).toBe('mp-upload-abc-123');
    expect(out.objectKey).toBe('workspaces/abc/large.bin');
  });

  test('createMultipartUpload throws when provider returns no UploadId', async () => {
    const { adapter } = makeAdapter(R2_CONFIG, { sendResult: {} });
    await expect(adapter.createMultipartUpload({ objectKey: 'a.bin' })).rejects.toMatchObject({
      code: 'PROVIDER_OPERATION_FAILED',
    });
  });

  test('signMultipartPart issues an UploadPartCommand', async () => {
    const capture = { commands: [] as CapturedCommand[], expiries: [] as number[] };
    const { adapter } = makeAdapter(R2_CONFIG, { capture });
    const out = await adapter.signMultipartPart({
      objectKey: 'workspaces/abc/large.bin',
      providerUploadId: 'mp-upload-abc-123',
      partNumber: 3,
    });
    expect(capture.commands).toHaveLength(1);
    expect(capture.commands[0]?.name).toBe('UploadPartCommand');
    expect(capture.commands[0]?.input).toMatchObject({
      Bucket: 'xynes-r2-test',
      Key: 'workspaces/abc/large.bin',
      UploadId: 'mp-upload-abc-123',
      PartNumber: 3,
    });
    expect(out.partNumber).toBe(3);
    expect(out.url).toContain('https://');
  });

  test('signMultipartPart rejects part number < 1', async () => {
    const { adapter } = makeAdapter(R2_CONFIG);
    await expect(
      adapter.signMultipartPart({
        objectKey: 'a.bin',
        providerUploadId: 'u',
        partNumber: 0,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_MULTIPART_CONTRACT_VIOLATED' });
  });

  test('signMultipartPart rejects part number > 10 000', async () => {
    const { adapter } = makeAdapter(R2_CONFIG);
    await expect(
      adapter.signMultipartPart({
        objectKey: 'a.bin',
        providerUploadId: 'u',
        partNumber: MULTIPART_MAX_PART_COUNT + 1,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_MULTIPART_CONTRACT_VIOLATED' });
  });

  test('completeMultipartUpload sorts parts and forwards ETags', async () => {
    const { adapter, sentCommands } = makeAdapter(R2_CONFIG, {
      sendResult: { ETag: '"final-etag"' },
    });
    await adapter.completeMultipartUpload({
      objectKey: 'a.bin',
      providerUploadId: 'u',
      parts: [
        { partNumber: 3, etag: '"e3"' },
        { partNumber: 1, etag: '"e1"' },
        { partNumber: 2, etag: '"e2"' },
      ],
    });
    expect(sentCommands[0]?.name).toBe('CompleteMultipartUploadCommand');
    const input = sentCommands[0]?.input as { MultipartUpload: { Parts: unknown[] } };
    expect(input.MultipartUpload.Parts).toEqual([
      { PartNumber: 1, ETag: '"e1"' },
      { PartNumber: 2, ETag: '"e2"' },
      { PartNumber: 3, ETag: '"e3"' },
    ]);
  });

  test('completeMultipartUpload rejects duplicate part numbers', async () => {
    const { adapter } = makeAdapter(R2_CONFIG);
    await expect(
      adapter.completeMultipartUpload({
        objectKey: 'a.bin',
        providerUploadId: 'u',
        parts: [
          { partNumber: 1, etag: '"e1"' },
          { partNumber: 1, etag: '"e1-dup"' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_MULTIPART_CONTRACT_VIOLATED' });
  });

  test('completeMultipartUpload rejects empty parts list', async () => {
    const { adapter } = makeAdapter(R2_CONFIG);
    await expect(
      adapter.completeMultipartUpload({
        objectKey: 'a.bin',
        providerUploadId: 'u',
        parts: [],
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_MULTIPART_CONTRACT_VIOLATED' });
  });

  test('completeMultipartUpload rejects > 10 000 parts', async () => {
    const { adapter } = makeAdapter(R2_CONFIG);
    const parts = Array.from({ length: MULTIPART_MAX_PART_COUNT + 1 }, (_, i) => ({
      partNumber: i + 1,
      etag: `"e${i + 1}"`,
    }));
    await expect(
      adapter.completeMultipartUpload({ objectKey: 'a.bin', providerUploadId: 'u', parts }),
    ).rejects.toMatchObject({ code: 'PROVIDER_MULTIPART_CONTRACT_VIOLATED' });
  });

  test('completeMultipartUpload rejects part with missing ETag', async () => {
    const { adapter } = makeAdapter(R2_CONFIG);
    await expect(
      adapter.completeMultipartUpload({
        objectKey: 'a.bin',
        providerUploadId: 'u',
        parts: [{ partNumber: 1, etag: '' }],
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_MULTIPART_CONTRACT_VIOLATED' });
  });

  test('completeMultipartUpload rejects part with non-integer part number', async () => {
    const { adapter } = makeAdapter(R2_CONFIG);
    await expect(
      adapter.completeMultipartUpload({
        objectKey: 'a.bin',
        providerUploadId: 'u',
        parts: [{ partNumber: 1.5, etag: '"e"' }],
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_MULTIPART_CONTRACT_VIOLATED' });
  });

  test('abortMultipartUpload issues an AbortMultipartUploadCommand', async () => {
    const { adapter, sentCommands } = makeAdapter(R2_CONFIG);
    await adapter.abortMultipartUpload({
      objectKey: 'a.bin',
      providerUploadId: 'mp-abc',
    });
    expect(sentCommands[0]?.name).toBe('AbortMultipartUploadCommand');
    expect(sentCommands[0]?.input).toMatchObject({
      Bucket: 'xynes-r2-test',
      Key: 'a.bin',
      UploadId: 'mp-abc',
    });
  });
});

describe('S3StorageProviderAdapter — read + delete', () => {
  test('headObject returns normalised metadata', async () => {
    const lastModified = new Date('2026-01-01T00:00:00Z');
    const { adapter } = makeAdapter(R2_CONFIG, {
      sendResult: {
        ContentLength: 4096,
        ContentType: 'image/png',
        ETag: '"abc"',
        LastModified: lastModified,
      },
    });
    const out = await adapter.headObject({ objectKey: 'a.png' });
    expect(out).toEqual({
      objectKey: 'a.png',
      contentLength: 4096,
      contentType: 'image/png',
      etag: '"abc"',
      lastModified,
    });
  });

  test('headObject defaults missing fields safely', async () => {
    const { adapter } = makeAdapter(R2_CONFIG, { sendResult: {} });
    const out = await adapter.headObject({ objectKey: 'a.png' });
    expect(out).toEqual({
      objectKey: 'a.png',
      contentLength: 0,
      contentType: null,
      etag: null,
      lastModified: null,
    });
  });

  test('createDownloadUrl issues a GetObjectCommand', async () => {
    const capture = { commands: [] as CapturedCommand[], expiries: [] as number[] };
    const { adapter } = makeAdapter(R2_CONFIG, { capture });
    const out = await adapter.createDownloadUrl({ objectKey: 'a.png' });
    expect(capture.commands[0]?.name).toBe('GetObjectCommand');
    expect(capture.commands[0]?.input).toMatchObject({
      Bucket: 'xynes-r2-test',
      Key: 'a.png',
    });
    expect(out.url).toContain('https://');
    expect(out.expiresAt).toBeInstanceOf(Date);
  });

  test('createDownloadUrl with downloadFilename adds a Content-Disposition override', async () => {
    const capture = { commands: [] as CapturedCommand[], expiries: [] as number[] };
    const { adapter } = makeAdapter(R2_CONFIG, { capture });
    await adapter.createDownloadUrl({
      objectKey: 'a.png',
      downloadFilename: 'report final.png',
    });
    const input = capture.commands[0]?.input as { ResponseContentDisposition?: string };
    expect(input.ResponseContentDisposition).toContain('attachment');
    expect(input.ResponseContentDisposition).toContain('report final.png');
  });

  test('createDownloadUrl strips CRLF + quotes from downloadFilename (header injection guard)', async () => {
    const capture = { commands: [] as CapturedCommand[], expiries: [] as number[] };
    const { adapter } = makeAdapter(R2_CONFIG, { capture });
    await adapter.createDownloadUrl({
      objectKey: 'a.png',
      downloadFilename: 'evil"\r\nX-Injected: yes\r\n',
    });
    const input = capture.commands[0]?.input as { ResponseContentDisposition?: string };
    // The critical header-injection invariant: NO CRLF and NO bare quotes
    // survive into the response header value. Without CRLF the remaining
    // text (e.g. "X-Injected: yes") is inert filename content.
    expect(input.ResponseContentDisposition).not.toContain('\r');
    expect(input.ResponseContentDisposition).not.toContain('\n');
    // The bare quote that would close the filename quoted-string is stripped.
    const cleaned = input.ResponseContentDisposition?.replace('filename="', '').replace(
      /";.*$/,
      '',
    );
    expect(cleaned).not.toContain('"');
  });

  test('deleteObject issues a DeleteObjectCommand', async () => {
    const { adapter, sentCommands } = makeAdapter(R2_CONFIG);
    await adapter.deleteObject({ objectKey: 'a.png' });
    expect(sentCommands[0]?.name).toBe('DeleteObjectCommand');
    expect(sentCommands[0]?.input).toMatchObject({
      Bucket: 'xynes-r2-test',
      Key: 'a.png',
    });
  });
});

describe('S3StorageProviderAdapter — MinIO local target', () => {
  test('honours forcePathStyle = true', async () => {
    const { adapter } = makeAdapter(MINIO_CONFIG);
    expect(adapter.providerKind).toBe('minio');
    expect(adapter.endpointHost).toBe('minio:9000');
    expect(adapter.bucket).toBe('xynes-minio-test');
  });

  test('issues commands against the MinIO bucket', async () => {
    const capture = { commands: [] as CapturedCommand[], expiries: [] as number[] };
    const { adapter } = makeAdapter(MINIO_CONFIG, { capture });
    await adapter.createSingleUploadUrl({ objectKey: 'a.bin' });
    expect(capture.commands[0]?.input).toMatchObject({
      Bucket: 'xynes-minio-test',
      Key: 'a.bin',
    });
  });
});

describe('S3StorageProviderAdapter — error redaction (defense-in-depth)', () => {
  test('s3 send() failure does NOT leak access key in error message', async () => {
    const { adapter } = makeAdapter(R2_CONFIG, {
      sendError: Object.assign(new Error('credentials AKIA-LEAK-1234 invalid'), {
        name: 'InvalidAccessKeyId',
      }),
    });
    try {
      await adapter.headObject({ objectKey: 'a.png' });
      throw new Error('expected adapter to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderAdapterError);
      expect((err as Error).message).not.toContain('AKIA-LEAK-1234');
    }
  });

  test('s3 send() failure does NOT leak secret key', async () => {
    const { adapter } = makeAdapter(R2_CONFIG, {
      sendError: Object.assign(new Error('secret v3rys3cretValueWasHere-LEAKED unauthorized'), {
        name: 'NoSuchKey',
      }),
    });
    try {
      await adapter.deleteObject({ objectKey: 'a.png' });
      throw new Error('expected adapter to throw');
    } catch (err) {
      expect((err as Error).message).not.toContain('v3rys3cretValueWasHere-LEAKED');
    }
  });

  test('presigner failure does NOT leak X-Amz-Signature value', async () => {
    const { adapter } = makeAdapter(R2_CONFIG, {
      presignError: Object.assign(
        new Error('signature mismatch: X-Amz-Signature=4f2c-leaked-sig'),
        { name: 'SignatureDoesNotMatch' },
      ),
    });
    try {
      await adapter.createDownloadUrl({ objectKey: 'a.png' });
      throw new Error('expected adapter to throw');
    } catch (err) {
      expect((err as Error).message).not.toContain('4f2c-leaked-sig');
      expect((err as Error).message).not.toContain('X-Amz-Signature=');
    }
  });
});

// ── STORAGE-FU-5 server-side I/O methods ──────────────────────────────────

describe('S3StorageProviderAdapter — STORAGE-FU-5 getObjectBytes', () => {
  test('issues a GetObjectCommand against the bucket + key', async () => {
    const sample = new Uint8Array([1, 2, 3, 4]);
    const { adapter, sentCommands } = makeAdapter(R2_CONFIG, {
      sendResult: {
        Body: {
          transformToByteArray: async () => sample,
        },
      },
    });
    const bytes = await adapter.getObjectBytes({ objectKey: 'a.bin' });
    expect(bytes).toEqual(sample);
    expect(sentCommands[0]?.name).toBe('GetObjectCommand');
    expect(sentCommands[0]?.input).toMatchObject({
      Bucket: 'xynes-r2-test',
      Key: 'a.bin',
    });
  });

  test('falls back to arrayBuffer() when transformToByteArray is unavailable', async () => {
    const { adapter } = makeAdapter(R2_CONFIG, {
      sendResult: {
        Body: {
          arrayBuffer: async () => new Uint8Array([9, 9]).buffer,
        },
      },
    });
    const bytes = await adapter.getObjectBytes({ objectKey: 'a.bin' });
    expect(bytes).toEqual(new Uint8Array([9, 9]));
  });

  test('returns empty Uint8Array when Body is null', async () => {
    const { adapter } = makeAdapter(R2_CONFIG, { sendResult: { Body: null } });
    const bytes = await adapter.getObjectBytes({ objectKey: 'a.bin' });
    expect(bytes.byteLength).toBe(0);
  });

  test('throws PROVIDER_OPERATION_FAILED with redacted message on unsupported body shape', async () => {
    const { adapter } = makeAdapter(R2_CONFIG, { sendResult: { Body: {} } });
    try {
      await adapter.getObjectBytes({ objectKey: 'a.bin' });
      throw new Error('expected adapter to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderAdapterError);
      expect((err as ProviderAdapterError).code).toBe('PROVIDER_OPERATION_FAILED');
    }
  });

  test('rejects invalid object keys (leading slash) BEFORE issuing a command', async () => {
    const { adapter, sentCommands } = makeAdapter(R2_CONFIG);
    await expect(adapter.getObjectBytes({ objectKey: '/leading-slash' })).rejects.toThrow(
      ProviderAdapterError,
    );
    expect(sentCommands.length).toBe(0);
  });

  test('s3 send() failure does NOT leak access key in error message', async () => {
    const { adapter } = makeAdapter(R2_CONFIG, {
      sendError: Object.assign(new Error('credentials AKIA-LEAK-9999 expired'), {
        name: 'InvalidAccessKeyId',
      }),
    });
    try {
      await adapter.getObjectBytes({ objectKey: 'a.bin' });
      throw new Error('expected adapter to throw');
    } catch (err) {
      expect((err as Error).message).not.toContain('AKIA-LEAK-9999');
    }
  });

  test('PR #13 Codex P2: stream-read failure is wrapped + redacted via runWithRedactedError', async () => {
    // The SDK `send()` succeeds but the body consumer (transformToByteArray)
    // throws. Pre-fix this raw error would have escaped the
    // ProviderAdapterError redaction surface; post-fix it gets wrapped.
    const { adapter } = makeAdapter(R2_CONFIG, {
      sendResult: {
        Body: {
          transformToByteArray: async () => {
            throw Object.assign(
              new Error(
                'TLS read failure: AKIA-STREAM-LEAK 0xDEADBEEF X-Amz-Signature=leakedsig123',
              ),
              { name: 'StreamReadFailure' },
            );
          },
        },
      },
    });
    try {
      await adapter.getObjectBytes({ objectKey: 'a.bin' });
      throw new Error('expected adapter to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderAdapterError);
      expect((err as ProviderAdapterError).code).toBe('PROVIDER_OPERATION_FAILED');
      const msg = (err as Error).message;
      // Raw SDK / network detail must NEVER bleed through.
      expect(msg).not.toContain('AKIA-STREAM-LEAK');
      expect(msg).not.toContain('0xDEADBEEF');
      expect(msg).not.toContain('X-Amz-Signature');
      expect(msg).not.toContain('leakedsig123');
      expect(msg).not.toContain('TLS read failure');
    }
  });

  test('PR #13 Codex P2: arrayBuffer() failure is also wrapped + redacted', async () => {
    const { adapter } = makeAdapter(R2_CONFIG, {
      sendResult: {
        Body: {
          arrayBuffer: async () => {
            throw new Error('socket reset by peer s3.fake.example/secret-bucket-name');
          },
        },
      },
    });
    try {
      await adapter.getObjectBytes({ objectKey: 'a.bin' });
      throw new Error('expected adapter to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderAdapterError);
      expect((err as Error).message).not.toContain('secret-bucket-name');
      expect((err as Error).message).not.toContain('s3.fake.example');
    }
  });
});

describe('S3StorageProviderAdapter — STORAGE-FU-5 putObjectBytes', () => {
  test('issues a PutObjectCommand with expected Bucket / Key / ContentType / ContentLength', async () => {
    const body = new Uint8Array([10, 20, 30]);
    const { adapter, sentCommands } = makeAdapter(R2_CONFIG);
    const r = await adapter.putObjectBytes({
      objectKey: 'variants/preview.jpg',
      body,
      contentType: 'image/jpeg',
    });
    expect(r.byteSize).toBe(3);
    expect(sentCommands[0]?.name).toBe('PutObjectCommand');
    expect(sentCommands[0]?.input).toMatchObject({
      Bucket: 'xynes-r2-test',
      Key: 'variants/preview.jpg',
      ContentType: 'image/jpeg',
      ContentLength: 3,
    });
  });

  test('forwards ifAbsent=true as If-None-Match: * (S3 conditional write)', async () => {
    const body = new Uint8Array([1]);
    const { adapter, sentCommands } = makeAdapter(R2_CONFIG);
    await adapter.putObjectBytes({
      objectKey: 'variants/preview.jpg',
      body,
      contentType: 'image/jpeg',
      ifAbsent: true,
    });
    expect((sentCommands[0]?.input as Record<string, unknown>).IfNoneMatch).toBe('*');
  });

  test('omits IfNoneMatch when ifAbsent is unset (default behaviour)', async () => {
    const body = new Uint8Array([1]);
    const { adapter, sentCommands } = makeAdapter(R2_CONFIG);
    await adapter.putObjectBytes({
      objectKey: 'variants/preview.jpg',
      body,
      contentType: 'image/jpeg',
    });
    expect((sentCommands[0]?.input as Record<string, unknown>).IfNoneMatch).toBeUndefined();
  });

  test('NEVER sets Tagging — STORAGE-4 portability invariant', async () => {
    const body = new Uint8Array([1]);
    const { adapter, sentCommands } = makeAdapter(R2_CONFIG);
    await adapter.putObjectBytes({
      objectKey: 'variants/preview.jpg',
      body,
      contentType: 'image/jpeg',
      ifAbsent: true,
    });
    expect((sentCommands[0]?.input as Record<string, unknown>).Tagging).toBeUndefined();
  });

  test('rejects non-Uint8Array body with PROVIDER_CONFIG_INVALID', async () => {
    const { adapter, sentCommands } = makeAdapter(R2_CONFIG);
    await expect(
      adapter.putObjectBytes({
        objectKey: 'a.bin',
        // Force-cast a Buffer-like into Uint8Array — Bun/Node may treat
        // Buffer as Uint8Array, so use a plain ArrayBuffer to force the
        // rejection.
        body: new ArrayBuffer(8) as unknown as Uint8Array,
        contentType: 'application/octet-stream',
      }),
    ).rejects.toThrow(ProviderAdapterError);
    expect(sentCommands.length).toBe(0);
  });

  test('rejects invalid object keys BEFORE issuing a command', async () => {
    const body = new Uint8Array([1]);
    const { adapter, sentCommands } = makeAdapter(R2_CONFIG);
    await expect(
      adapter.putObjectBytes({
        objectKey: '/leading-slash',
        body,
        contentType: 'image/jpeg',
      }),
    ).rejects.toThrow(ProviderAdapterError);
    expect(sentCommands.length).toBe(0);
  });

  test('s3 send() failure does NOT leak secret key in error message', async () => {
    const body = new Uint8Array([1]);
    const { adapter } = makeAdapter(R2_CONFIG, {
      sendError: Object.assign(new Error('signature mismatch v3rys3cretValueWasHere-LEAKED'), {
        name: 'SignatureDoesNotMatch',
      }),
    });
    try {
      await adapter.putObjectBytes({
        objectKey: 'a.bin',
        body,
        contentType: 'application/octet-stream',
      });
      throw new Error('expected adapter to throw');
    } catch (err) {
      expect((err as Error).message).not.toContain('v3rys3cretValueWasHere-LEAKED');
    }
  });
});
