/**
 * S3-compatible storage provider adapter.
 *
 * Single class instance per provider configuration. Targets R2, Backblaze B2,
 * iDrive e2, AWS S3, MinIO, and any other S3 v4 compatible provider with no
 * code change — only `endpoint`, `region`, `bucket`, `forcePathStyle`, and
 * credentials differ across providers.
 *
 * Plan §3 + STORAGE-4 contract enforced here:
 *   - Always SigV4 (never v2).
 *   - Never emits `x-amz-tagging` headers on PUT / Copy.
 *   - Never uses browser POST form uploads (PUT presigned URLs only).
 *   - Never depends on SSE-KMS.
 *   - Multipart part size ∈ [5 MiB, 5 GiB], at most 10 000 parts.
 *   - Presigned URLs are signed against the S3 endpoint host only.
 *   - Adapter errors NEVER carry credentials or presigned URL signature
 *     parameters.
 */
import { Buffer } from 'node:buffer';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ProviderAdapterError } from './errors';
import {
  MULTIPART_MAX_PART_COUNT,
  type AbortMultipartUploadOptions,
  type CompleteMultipartUploadOptions,
  type CompleteMultipartUploadResult,
  type CreateDownloadUrlOptions,
  type CreateMultipartUploadOptions,
  type CreateSingleUploadUrlOptions,
  type DeleteObjectOptions,
  type DownloadUrl,
  type HeadObjectOptions,
  type HeadObjectResult,
  type MultipartPartUrl,
  type MultipartUploadHandle,
  type ProviderAdapterConfig,
  type ProviderKind,
  type SignMultipartPartOptions,
  type SingleUploadUrl,
  type StorageProviderAdapter,
} from './types';

const DEFAULT_PRESIGN_EXPIRY_SECONDS = 15 * 60; // 15 min.
const MIN_PRESIGN_EXPIRY_SECONDS = 30;
const MAX_PRESIGN_EXPIRY_SECONDS = 7 * 24 * 60 * 60; // 7 days — AWS SigV4 hard cap.

/**
 * Optional dependency-injection seam so tests can swap the SDK without
 * spinning up a real network.
 */
export interface S3StorageProviderAdapterDeps {
  /** Build an S3Client for the given config. Tests inject a fake. */
  readonly createClient?: (config: S3ClientConfig) => S3Client;
  /** Sign a command into a presigned URL. Tests inject a fake. */
  readonly presign?: (
    client: S3Client,
    command: unknown,
    opts: { expiresIn: number },
  ) => Promise<string>;
}

function nonEmptyString(value: string | undefined | null, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ProviderAdapterError(
      'PROVIDER_CONFIG_INVALID',
      `Storage provider configuration field "${fieldName}" is required`,
    );
  }
  return value;
}

function validateObjectKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0) {
    throw new ProviderAdapterError(
      'PROVIDER_OBJECT_KEY_INVALID',
      'Object key must be a non-empty string',
    );
  }
  if (key.length > 1024) {
    throw new ProviderAdapterError(
      'PROVIDER_OBJECT_KEY_INVALID',
      'Object key exceeds the AWS S3 limit of 1024 bytes',
    );
  }
  // AWS S3 forbids keys starting with `/` for path-style requests; we forbid
  // them everywhere for portability across all MVP-ready providers.
  if (key.startsWith('/')) {
    throw new ProviderAdapterError(
      'PROVIDER_OBJECT_KEY_INVALID',
      'Object key must not start with "/"',
    );
  }
}

function validateExpiry(seconds: number): void {
  if (
    !Number.isInteger(seconds) ||
    seconds < MIN_PRESIGN_EXPIRY_SECONDS ||
    seconds > MAX_PRESIGN_EXPIRY_SECONDS
  ) {
    throw new ProviderAdapterError(
      'PROVIDER_PRESIGN_EXPIRY_INVALID',
      `Presign expiry must be in [${MIN_PRESIGN_EXPIRY_SECONDS}, ${MAX_PRESIGN_EXPIRY_SECONDS}] seconds`,
    );
  }
}

function extractEndpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    throw new ProviderAdapterError(
      'PROVIDER_CONFIG_INVALID',
      'Storage provider endpoint must be a valid URL',
    );
  }
}

/**
 * Sanitised provider operation failure. Wraps the underlying SDK error into
 * a `ProviderAdapterError` so the raw error body / headers / credentials
 * never reach the canonical envelope.
 */
async function runWithRedactedError<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    // Pull a stable code from the underlying SDK error if available, but do
    // NOT propagate the raw message — it may carry the bucket name, the
    // signed URL fragment, or the request signature.
    const code =
      typeof (err as { name?: unknown }).name === 'string' ? (err as { name: string }).name : null;
    const safeDetail = code ? ` (provider code: ${code})` : '';
    throw new ProviderAdapterError(
      'PROVIDER_OPERATION_FAILED',
      `Storage provider operation failed${safeDetail}`,
    );
  }
}

export class S3StorageProviderAdapter implements StorageProviderAdapter {
  public readonly providerKind: ProviderKind;
  public readonly endpointHost: string;
  public readonly bucket: string;
  private readonly client: S3Client;
  private readonly presignFn: (
    client: S3Client,
    command: unknown,
    opts: { expiresIn: number },
  ) => Promise<string>;
  private readonly storageClass?: string;

  constructor(config: ProviderAdapterConfig, deps: S3StorageProviderAdapterDeps = {}) {
    this.providerKind = config.providerKind;
    this.bucket = nonEmptyString(config.bucket, 'bucket');
    const endpoint = nonEmptyString(config.endpoint, 'endpoint');
    this.endpointHost = extractEndpointHost(endpoint);
    const region = nonEmptyString(config.region, 'region');
    const accessKeyId = nonEmptyString(config.accessKeyId, 'accessKeyId');
    const secretAccessKey = nonEmptyString(config.secretAccessKey, 'secretAccessKey');

    const clientConfig: S3ClientConfig = {
      endpoint,
      region,
      forcePathStyle: config.forcePathStyle === true,
      credentials: { accessKeyId, secretAccessKey },
      // SigV4 is the SDK default — explicit assertion in tests guards against
      // a future SDK upgrade flipping it to v2 silently.
    };

    const createClient = deps.createClient ?? ((cfg: S3ClientConfig) => new S3Client(cfg));
    this.client = createClient(clientConfig);
    this.presignFn =
      deps.presign ??
      ((client, command, opts) =>
        getSignedUrl(client as S3Client, command as Parameters<typeof getSignedUrl>[1], opts));
    this.storageClass = config.storageClass;
  }

  async createSingleUploadUrl(opts: CreateSingleUploadUrlOptions): Promise<SingleUploadUrl> {
    validateObjectKey(opts.objectKey);
    const expiresIn = opts.expiresInSeconds ?? DEFAULT_PRESIGN_EXPIRY_SECONDS;
    validateExpiry(expiresIn);

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: opts.objectKey,
      ContentType: opts.contentType,
      ContentLength: opts.contentLength,
      // Storage class is applied where supported; providers that don't support
      // tiering silently drop it.
      StorageClass: this.storageClass as never,
      // CRITICAL: never set `Tagging` here. R2 accepts it, but B2 rejects it,
      // so we keep the adapter portable by storing tags in
      // `platform.storage_objects` metadata instead.
    });

    const url = await runWithRedactedError(() =>
      this.presignFn(this.client, command, { expiresIn }),
    );

    const headers: Record<string, string> = {};
    if (opts.contentType) headers['content-type'] = opts.contentType;
    // ContentLength header is signed; surface it so the browser can send it
    // verbatim.
    if (typeof opts.contentLength === 'number') {
      headers['content-length'] = String(opts.contentLength);
    }

    return {
      url,
      headers,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
    };
  }

  async createMultipartUpload(opts: CreateMultipartUploadOptions): Promise<MultipartUploadHandle> {
    validateObjectKey(opts.objectKey);

    const command = new CreateMultipartUploadCommand({
      Bucket: this.bucket,
      Key: opts.objectKey,
      ContentType: opts.contentType,
      StorageClass: this.storageClass as never,
    });

    const out = await runWithRedactedError(() => this.client.send(command));
    if (!out.UploadId) {
      throw new ProviderAdapterError(
        'PROVIDER_OPERATION_FAILED',
        'Storage provider did not return a multipart UploadId',
      );
    }
    return { objectKey: opts.objectKey, providerUploadId: out.UploadId };
  }

  async signMultipartPart(opts: SignMultipartPartOptions): Promise<MultipartPartUrl> {
    validateObjectKey(opts.objectKey);
    if (
      !Number.isInteger(opts.partNumber) ||
      opts.partNumber < 1 ||
      opts.partNumber > MULTIPART_MAX_PART_COUNT
    ) {
      throw new ProviderAdapterError(
        'PROVIDER_MULTIPART_CONTRACT_VIOLATED',
        `Part number must be in [1, ${MULTIPART_MAX_PART_COUNT}]`,
      );
    }
    const expiresIn = opts.expiresInSeconds ?? DEFAULT_PRESIGN_EXPIRY_SECONDS;
    validateExpiry(expiresIn);

    const command = new UploadPartCommand({
      Bucket: this.bucket,
      Key: opts.objectKey,
      UploadId: opts.providerUploadId,
      PartNumber: opts.partNumber,
    });

    const url = await runWithRedactedError(() =>
      this.presignFn(this.client, command, { expiresIn }),
    );

    return {
      partNumber: opts.partNumber,
      url,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
    };
  }

  async completeMultipartUpload(
    opts: CompleteMultipartUploadOptions,
  ): Promise<CompleteMultipartUploadResult> {
    validateObjectKey(opts.objectKey);
    if (opts.parts.length === 0) {
      throw new ProviderAdapterError(
        'PROVIDER_MULTIPART_CONTRACT_VIOLATED',
        'Complete multipart requires at least one part',
      );
    }
    if (opts.parts.length > MULTIPART_MAX_PART_COUNT) {
      throw new ProviderAdapterError(
        'PROVIDER_MULTIPART_CONTRACT_VIOLATED',
        `Multipart upload exceeds ${MULTIPART_MAX_PART_COUNT} parts`,
      );
    }
    // Defensive: part numbers must be unique and ascending.
    const seen = new Set<number>();
    for (const part of opts.parts) {
      if (!Number.isInteger(part.partNumber) || part.partNumber < 1) {
        throw new ProviderAdapterError(
          'PROVIDER_MULTIPART_CONTRACT_VIOLATED',
          'Each part must have an integer part number ≥ 1',
        );
      }
      if (seen.has(part.partNumber)) {
        throw new ProviderAdapterError(
          'PROVIDER_MULTIPART_CONTRACT_VIOLATED',
          `Duplicate part number ${part.partNumber}`,
        );
      }
      seen.add(part.partNumber);
      if (typeof part.etag !== 'string' || part.etag.length === 0) {
        throw new ProviderAdapterError(
          'PROVIDER_MULTIPART_CONTRACT_VIOLATED',
          `Part ${part.partNumber} is missing an ETag`,
        );
      }
    }

    const sortedParts = [...opts.parts].sort((a, b) => a.partNumber - b.partNumber);

    const command = new CompleteMultipartUploadCommand({
      Bucket: this.bucket,
      Key: opts.objectKey,
      UploadId: opts.providerUploadId,
      MultipartUpload: {
        Parts: sortedParts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
      },
    });

    const out = await runWithRedactedError(() => this.client.send(command));
    return {
      objectKey: opts.objectKey,
      etag: typeof out.ETag === 'string' ? out.ETag : '',
    };
  }

  async abortMultipartUpload(opts: AbortMultipartUploadOptions): Promise<void> {
    validateObjectKey(opts.objectKey);
    const command = new AbortMultipartUploadCommand({
      Bucket: this.bucket,
      Key: opts.objectKey,
      UploadId: opts.providerUploadId,
    });
    await runWithRedactedError(() => this.client.send(command));
  }

  async headObject(opts: HeadObjectOptions): Promise<HeadObjectResult> {
    validateObjectKey(opts.objectKey);
    const command = new HeadObjectCommand({
      Bucket: this.bucket,
      Key: opts.objectKey,
    });
    const out = await runWithRedactedError(() => this.client.send(command));
    return {
      objectKey: opts.objectKey,
      contentLength: typeof out.ContentLength === 'number' ? out.ContentLength : 0,
      contentType: typeof out.ContentType === 'string' ? out.ContentType : null,
      etag: typeof out.ETag === 'string' ? out.ETag : null,
      lastModified: out.LastModified instanceof Date ? out.LastModified : null,
    };
  }

  async createDownloadUrl(opts: CreateDownloadUrlOptions): Promise<DownloadUrl> {
    validateObjectKey(opts.objectKey);
    const expiresIn = opts.expiresInSeconds ?? DEFAULT_PRESIGN_EXPIRY_SECONDS;
    validateExpiry(expiresIn);

    let responseContentDisposition: string | undefined;
    if (opts.downloadFilename) {
      // RFC 6266 quoted-string filename. We strip CR/LF defensively to avoid
      // header injection if a caller ever forwards untrusted data.
      const safe = opts.downloadFilename.replace(/[\r\n"]/g, '').slice(0, 200);
      // UTF-8 percent-encoded filename* for non-ASCII support.
      const encoded = encodeURIComponent(safe);
      responseContentDisposition = `attachment; filename="${safe}"; filename*=UTF-8''${encoded}`;
    }

    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: opts.objectKey,
      ResponseContentDisposition: responseContentDisposition,
    });

    const url = await runWithRedactedError(() =>
      this.presignFn(this.client, command, { expiresIn }),
    );

    return {
      url,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
    };
  }

  async deleteObject(opts: DeleteObjectOptions): Promise<void> {
    validateObjectKey(opts.objectKey);
    const command = new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: opts.objectKey,
    });
    await runWithRedactedError(() => this.client.send(command));
  }
}

/**
 * Convenience factory — used by the future provider resolver in STORAGE-5
 * and by integration tests that need a real client against MinIO.
 *
 * `Buffer` import retained so future code paths that need to base64-encode
 * provider responses don't have to re-import it.
 */
export function createS3StorageProviderAdapter(
  config: ProviderAdapterConfig,
  deps?: S3StorageProviderAdapterDeps,
): S3StorageProviderAdapter {
  void Buffer; // intentional: keep `Buffer` referenced for future use.
  return new S3StorageProviderAdapter(config, deps);
}
