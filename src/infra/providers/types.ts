/**
 * Provider adapter contract.
 *
 * The adapter is provider-neutral by design. Plan §3 enumerates the cross-
 * provider quirks the adapter MUST normalise (region semantics, endpoint
 * shape, presigned URL surface, `x-amz-tagging`, CORS XML limits, etc.).
 * The interface here exposes one method per operation; per-provider
 * differences are absorbed by configuration on `ProviderAdapterConfig`,
 * NOT by branching inside callers.
 *
 * Adapter invariants (security + portability):
 *   - ALWAYS sign SigV4. Never SigV2.
 *   - NEVER emit `x-amz-tagging` headers on PUT / Copy. Tags live in
 *     `platform.storage_objects` metadata, not provider headers (B2 rejects
 *     them; we mirror that posture on every provider for portability).
 *   - NEVER use browser POST form uploads. Always PUT presigned URLs.
 *   - NEVER depend on SSE-KMS. SSE-C is the only customer-key path in MVP.
 *   - Multipart parts ∈ [5 MiB, 5 GiB], at most 10 000 parts total, except
 *     the final part may be smaller than 5 MiB (AWS S3 contract; R2 / B2 /
 *     iDrive e2 all enforce it).
 *   - Presigned URLs MUST be signed against the S3 endpoint host only —
 *     custom CDN domains are a post-processing concern, not adapter scope.
 *   - Adapter errors NEVER include `accessKeyId`, `secretAccessKey`, raw
 *     provider error bodies, or presigned URL signature parameters.
 */

/**
 * `provider_kind` discriminator from `platform.workspace_storage_providers`.
 *
 * The adapter does NOT branch on this value for endpoint / region / host
 * construction. It is used only for the per-provider quirks table (storage
 * class support, etc.) and for the `STORAGE_SMOKE_PROVIDER` rollout
 * checklist.
 */
export type ProviderKind = 'r2' | 'b2' | 'idrive_e2' | 'aws_s3' | 's3_generic' | 'minio';

/**
 * Opaque provider configuration. Every field is supplied by the caller
 * (resolved from `platform.workspace_storage_providers` + secret-manager
 * `credential_ref`). The adapter never derives any of these from
 * `providerKind`.
 */
export interface ProviderAdapterConfig {
  readonly providerKind: ProviderKind;
  /**
   * Full S3 endpoint URL.
   *   R2:        `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`
   *   B2:        `https://s3.<region>.backblazeb2.com`
   *   iDrive e2: per-account console URL (only after region enablement)
   *   MinIO:     `http://minio:9000`
   */
  readonly endpoint: string;
  /**
   * Provider region string. R2: `auto`. B2 / iDrive e2 / AWS S3: real region.
   * MinIO: `us-east-1` by convention.
   */
  readonly region: string;
  /** Bucket name. Adapter NEVER auto-creates buckets — owner-managed. */
  readonly bucket: string;
  /**
   * Defaults to `false`. Force `true` for MinIO and any provider that
   * requires path-style addressing.
   */
  readonly forcePathStyle?: boolean;
  /**
   * Resolved from `credential_ref` against the secret manager. The raw key
   * NEVER touches Postgres and NEVER appears in adapter errors.
   */
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /**
   * Optional storage class. R2 supports `STANDARD` / `STANDARD_IA`; other
   * providers ignore it. Adapter silently drops it on providers that don't
   * support tiering.
   */
  readonly storageClass?: string;
}

/**
 * AWS S3 multipart contract — enforced uniformly across all providers.
 */
export const MULTIPART_MIN_PART_SIZE = 5 * 1024 * 1024; // 5 MiB
export const MULTIPART_MAX_PART_SIZE = 5 * 1024 * 1024 * 1024; // 5 GiB
export const MULTIPART_MAX_PART_COUNT = 10_000;

export interface CreateSingleUploadUrlOptions {
  readonly objectKey: string;
  readonly contentType?: string;
  readonly contentLength?: number;
  /** Expiry in seconds. Defaults to 900 (15 min). Capped to 7 days by AWS SigV4. */
  readonly expiresInSeconds?: number;
}

export interface SingleUploadUrl {
  readonly url: string;
  /**
   * Headers the browser MUST send verbatim. `x-amz-*` headers are signed —
   * altering them invalidates the signature.
   */
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: Date;
}

export interface CreateMultipartUploadOptions {
  readonly objectKey: string;
  readonly contentType?: string;
}

export interface MultipartUploadHandle {
  readonly objectKey: string;
  readonly providerUploadId: string;
}

export interface SignMultipartPartOptions {
  readonly objectKey: string;
  readonly providerUploadId: string;
  /** Part number ∈ [1, 10000]. */
  readonly partNumber: number;
  /** Expiry in seconds. Defaults to 900 (15 min). */
  readonly expiresInSeconds?: number;
}

export interface MultipartPartUrl {
  readonly partNumber: number;
  readonly url: string;
  readonly expiresAt: Date;
}

export interface CompletedMultipartPart {
  readonly partNumber: number;
  readonly etag: string;
}

export interface CompleteMultipartUploadOptions {
  readonly objectKey: string;
  readonly providerUploadId: string;
  readonly parts: ReadonlyArray<CompletedMultipartPart>;
}

export interface CompleteMultipartUploadResult {
  readonly objectKey: string;
  readonly etag: string;
}

export interface AbortMultipartUploadOptions {
  readonly objectKey: string;
  readonly providerUploadId: string;
}

export interface HeadObjectOptions {
  readonly objectKey: string;
}

export interface HeadObjectResult {
  readonly objectKey: string;
  readonly contentLength: number;
  readonly contentType: string | null;
  readonly etag: string | null;
  readonly lastModified: Date | null;
}

export interface CreateDownloadUrlOptions {
  readonly objectKey: string;
  readonly expiresInSeconds?: number;
  /** When set, returned URL forces a download with this filename. */
  readonly downloadFilename?: string;
}

export interface DownloadUrl {
  readonly url: string;
  readonly expiresAt: Date;
}

export interface DeleteObjectOptions {
  readonly objectKey: string;
}

/**
 * Adapter contract. Every method takes named options so the interface
 * stays additive (new opts can be added without breaking callers).
 */
export interface StorageProviderAdapter {
  readonly providerKind: ProviderKind;
  /** S3 endpoint host (NOT the workspace's CDN domain). */
  readonly endpointHost: string;
  /** Bucket the adapter targets. */
  readonly bucket: string;

  createSingleUploadUrl(opts: CreateSingleUploadUrlOptions): Promise<SingleUploadUrl>;
  createMultipartUpload(opts: CreateMultipartUploadOptions): Promise<MultipartUploadHandle>;
  signMultipartPart(opts: SignMultipartPartOptions): Promise<MultipartPartUrl>;
  completeMultipartUpload(
    opts: CompleteMultipartUploadOptions,
  ): Promise<CompleteMultipartUploadResult>;
  abortMultipartUpload(opts: AbortMultipartUploadOptions): Promise<void>;
  headObject(opts: HeadObjectOptions): Promise<HeadObjectResult>;
  createDownloadUrl(opts: CreateDownloadUrlOptions): Promise<DownloadUrl>;
  deleteObject(opts: DeleteObjectOptions): Promise<void>;
}
