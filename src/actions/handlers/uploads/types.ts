/**
 * Repository + adapter resolver contracts for upload session lifecycle.
 *
 * The handlers are fully DI-driven: production wires Drizzle-backed
 * repositories (landed by a follow-up infra story when DB access ships
 * to storage-service), tests inject fakes.
 *
 * The repository interfaces deliberately:
 *   - Surface DTOs, NOT raw DB rows. Raw rows carry `provider_object_key`
 *     and `provider_id` fields that the handlers MUST NOT echo back to
 *     callers.
 *   - Use `Result<T> | null` for "not found" / "not for this workspace"
 *     instead of raising — that lets the handlers shape every error
 *     envelope locally (no leakage of internal stack traces).
 *   - Run create + create-session as ONE atomic operation
 *     (`createObjectWithSession`) so we never end up with an orphaned
 *     `storage_objects` row if the upload session insert fails.
 */
import type { ProviderKind, StorageProviderAdapter } from '../../../infra/providers/types';

// ── DTOs (handler-internal; never echoed verbatim) ─────────────────────────

export type ObjectStatus =
  | 'pending_upload'
  | 'uploaded'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'deleted';

export type UploadSessionStatus = 'pending' | 'completed' | 'aborted' | 'expired';

export type UploadMethod = 'single' | 'multipart';

export type Visibility = 'private' | 'public';

export interface StorageObjectRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly providerId: string;
  readonly providerObjectKey: string;
  readonly filename: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly sha256: string | null;
  readonly purpose: string;
  readonly visibility: Visibility;
  readonly status: ObjectStatus;
  readonly compressionRequested: boolean;
  readonly createdBy: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly uploadedAt: Date | null;
}

export interface UploadSessionRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly objectId: string;
  readonly uploadMethod: UploadMethod;
  readonly providerUploadId: string | null;
  readonly status: UploadSessionStatus;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly completedAt: Date | null;
  readonly abortedAt: Date | null;
  readonly createdBy: string | null;
}

/** Minimum provider config the resolver hands to the handlers. */
export interface ResolvedProvider {
  readonly providerId: string;
  readonly providerKind: ProviderKind;
  readonly adapter: StorageProviderAdapter;
}

// ── Repository interfaces ──────────────────────────────────────────────────

export interface CreateObjectWithSessionInput {
  readonly objectId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly providerId: string;
  readonly providerObjectKey: string;
  readonly filename: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly sha256: string | null;
  readonly purpose: string;
  readonly visibility: Visibility;
  readonly compressionRequested: boolean;
  readonly uploadMethod: UploadMethod;
  readonly providerUploadId: string | null;
  readonly expiresAt: Date;
  readonly createdBy: string | null;
}

export interface CreateObjectWithSessionResult {
  readonly object: StorageObjectRecord;
  readonly session: UploadSessionRecord;
}

export interface StorageObjectRepository {
  /**
   * Mark an object as `uploaded` and stamp `uploaded_at`. Idempotent:
   * calling it on an already-`uploaded` row is a no-op and returns the
   * row unchanged. Returns `null` only when the object id does not exist
   * or does not belong to the workspace.
   */
  markUploaded(input: {
    objectId: string;
    workspaceId: string;
    sha256: string | null;
  }): Promise<StorageObjectRecord | null>;

  /**
   * Lookup a single object scoped to the workspace. Returns `null` if
   * the row does not exist OR if it exists but is owned by a different
   * workspace (cross-workspace denial is a "not found" envelope, NOT
   * a 403, to avoid leaking object existence across workspace
   * boundaries).
   */
  findByIdForWorkspace(input: {
    objectId: string;
    workspaceId: string;
  }): Promise<StorageObjectRecord | null>;
}

export interface UploadSessionRepository {
  /**
   * Insert one object row + one upload session row in a single transaction
   * (or equivalent atomic op). Implementations MUST guarantee that a
   * failure on the session insert rolls back the object insert — we never
   * want orphan rows.
   */
  createObjectWithSession(
    input: CreateObjectWithSessionInput,
  ): Promise<CreateObjectWithSessionResult>;

  /**
   * Lookup a session by id, scoped to the workspace. Returns `null` if
   * the session does not exist OR belongs to a different workspace.
   */
  findByIdForWorkspace(input: {
    sessionId: string;
    workspaceId: string;
  }): Promise<UploadSessionRecord | null>;

  /**
   * Mark the session `completed` (and stamp `completed_at`) provided the
   * current row is still `pending` AND its `expires_at` is in the future.
   * Returns `null` if the conditional update did not match a row (already
   * completed / aborted / expired / unknown).
   */
  markCompletedIfPending(input: {
    sessionId: string;
    workspaceId: string;
    now: Date;
  }): Promise<UploadSessionRecord | null>;

  /**
   * Mark the session `aborted` (and stamp `aborted_at`) provided the
   * current row is still `pending`. Returns the updated row, or `null` if
   * the conditional update did not match.
   */
  markAbortedIfPending(input: {
    sessionId: string;
    workspaceId: string;
    now: Date;
  }): Promise<UploadSessionRecord | null>;
}

// ── Provider resolver ──────────────────────────────────────────────────────

/**
 * Resolves the default provider for a workspace and returns an instantiated
 * adapter. The handlers call this once per request — the resolver is free
 * to cache adapters per provider config, but MUST NOT cache them across
 * `credential_ref` rotations.
 *
 * Returns `null` when no default provider is configured for the workspace.
 */
export interface StorageProviderResolver {
  resolveDefaultForWorkspace(workspaceId: string): Promise<ResolvedProvider | null>;
}

// ── Aggregated dependency type ─────────────────────────────────────────────

/**
 * STORAGE-7 — opaque enqueue callback wired by the service composition
 * root after STORAGE-7's queue + status repositories are constructed.
 *
 * The complete handler calls this AFTER the session has been atomically
 * flipped to `completed` and the object row has been flipped to
 * `uploaded`. The callback returns the list of just-enqueued public
 * processing-job DTOs (or `[]` when STORAGE-7 is not wired) so the
 * upload-complete response can surface them to the caller.
 *
 * STORAGE-5 tests omit this callback entirely; the complete handler
 * defaults to returning `processingJobs: []`. This preserves STORAGE-5's
 * test posture byte-for-byte.
 */
export type EnqueueProcessingCallback = (input: {
  objectId: string;
  workspaceId: string;
}) => Promise<ReadonlyArray<unknown>>;

export interface UploadHandlerDependencies {
  readonly objects: StorageObjectRepository;
  readonly sessions: UploadSessionRepository;
  readonly providers: StorageProviderResolver;
  /** Defaults to `() => new Date()`. Overridable for deterministic tests. */
  readonly now?: () => Date;
  /** Defaults to `crypto.randomUUID()`. Overridable for deterministic tests. */
  readonly idFactory?: () => string;
  /** Defaults to 15 minutes; bounded to [60 s, 24 h]. */
  readonly sessionTtlSeconds?: number;
  /** Defaults to 100 MB (matches AWS guidance and `ServiceConfig`). */
  readonly multipartThresholdBytes?: number;
  /**
   * STORAGE-7 hook. When set, the complete handler calls this after the
   * object/session state transition lands and forwards the returned
   * job DTOs to the response. When absent, the complete handler returns
   * `processingJobs: []` (the STORAGE-5 default).
   *
   * The callback MUST be defensive: failures inside it MUST NOT bubble
   * up and undo the upload-complete success — the worker can be retried
   * by the scheduled-publisher loop. The complete handler treats a
   * thrown callback as "no jobs enqueued" and logs nothing the caller
   * can see (defense-in-depth on top of the logger redaction).
   */
  readonly enqueueProcessing?: EnqueueProcessingCallback;
}
