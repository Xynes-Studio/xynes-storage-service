/**
 * Upload session response builders.
 *
 * STORAGE-5 acceptance criteria:
 *   - Errors never include signed URL secrets, presigned URL signature
 *     parameters, provider credentials, or any per-provider config from
 *     `platform.workspace_storage_providers`.
 *   - Response shape MUST NOT leak `provider_kind`, `endpoint`, `region`,
 *     `bucket`, `provider_object_key`, or `credential_ref` as a top-level
 *     field.
 *
 * These builders are the single point where StorageObjectRecord /
 * UploadSessionRecord rows become wire DTOs. Every handler returns a
 * value shaped by this module and nothing else.
 */
import type { StorageObjectRecord, UploadMethod, UploadSessionRecord } from './types';

/**
 * Public-facing object DTO. Mirrors plan §7.1 "object" surface.
 *
 * Explicit field allowlist — `provider_kind`, `endpoint`, `region`,
 * `bucket`, `provider_object_key`, `credential_ref`, `accessKeyId`,
 * `secretAccessKey`, `providerId`, raw provider URLs and presigned-URL
 * signature parameters are deliberately ABSENT.
 */
export interface PublicStorageObject {
  readonly id: string;
  readonly workspaceId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly sha256: string | null;
  readonly purpose: string;
  readonly visibility: string;
  readonly status: string;
  readonly compressionRequested: boolean;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly uploadedAt: string | null;
}

export interface PublicUploadSession {
  readonly id: string;
  readonly objectId: string;
  readonly uploadMethod: UploadMethod;
  readonly status: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly completedAt: string | null;
  readonly abortedAt: string | null;
}

export function toPublicObject(row: StorageObjectRecord): PublicStorageObject {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    filename: row.filename,
    contentType: row.contentType,
    byteSize: row.byteSize,
    sha256: row.sha256,
    purpose: row.purpose,
    visibility: row.visibility,
    status: row.status,
    compressionRequested: row.compressionRequested,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    uploadedAt: row.uploadedAt ? row.uploadedAt.toISOString() : null,
  };
}

export function toPublicSession(row: UploadSessionRecord): PublicUploadSession {
  return {
    id: row.id,
    objectId: row.objectId,
    uploadMethod: row.uploadMethod,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    abortedAt: row.abortedAt ? row.abortedAt.toISOString() : null,
  };
}

// ── Create upload session response ────────────────────────────────────────

export interface CreateUploadSessionPartUrl {
  readonly partNumber: number;
  readonly url: string;
  readonly expiresAt: string;
}

export interface CreateUploadSessionResponse {
  readonly uploadId: string;
  readonly objectId: string;
  readonly uploadMethod: UploadMethod;
  readonly uploadUrl: string | null;
  readonly uploadHeaders: Readonly<Record<string, string>>;
  readonly parts: ReadonlyArray<CreateUploadSessionPartUrl>;
  readonly expiresAt: string;
  readonly object: PublicStorageObject;
}

// ── Complete / abort session responses ────────────────────────────────────

export interface CompleteUploadSessionResponse {
  readonly object: PublicStorageObject;
  readonly session: PublicUploadSession;
  /** Filled by STORAGE-7. STORAGE-5 returns an empty array. */
  readonly processingJobs: ReadonlyArray<unknown>;
}

export interface AbortUploadSessionResponse {
  readonly session: PublicUploadSession;
}
