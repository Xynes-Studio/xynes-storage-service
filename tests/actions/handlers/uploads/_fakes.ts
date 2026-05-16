/**
 * Test fakes for the upload session lifecycle handlers.
 *
 * The fakes deliberately:
 *   - Implement the FULL repository / resolver contract so tests can exercise
 *     the happy paths AND the conditional-update / race-loss / not-found
 *     branches with one shared fixture.
 *   - Capture every adapter call (and its options) so redaction tests can
 *     assert credentials never reach the adapter from the handler.
 *   - Inject deterministic ids + clocks via the handler `idFactory` + `now`
 *     hooks, NOT by monkey-patching `crypto.randomUUID`.
 */
import type {
  AbortMultipartUploadOptions,
  CompleteMultipartUploadOptions,
  CompleteMultipartUploadResult,
  CreateDownloadUrlOptions,
  CreateMultipartUploadOptions,
  CreateSingleUploadUrlOptions,
  DeleteObjectOptions,
  DownloadUrl,
  HeadObjectOptions,
  HeadObjectResult,
  MultipartPartUrl,
  MultipartUploadHandle,
  ProviderKind,
  SignMultipartPartOptions,
  SingleUploadUrl,
  StorageProviderAdapter,
} from '../../../../src/infra/providers/types';
import type {
  CreateObjectWithSessionInput,
  CreateObjectWithSessionResult,
  ResolvedProvider,
  StorageObjectRecord,
  StorageObjectRepository,
  StorageProviderResolver,
  UploadHandlerDependencies,
  UploadSessionRecord,
  UploadSessionRepository,
} from '../../../../src/actions/handlers/uploads/types';

export interface AdapterCall<T> {
  readonly method: string;
  readonly opts: T;
}

export class FakeStorageAdapter implements StorageProviderAdapter {
  public readonly providerKind: ProviderKind;
  public readonly endpointHost = 's3.fake.example';
  public readonly bucket = 'fake-bucket';

  public readonly calls: AdapterCall<unknown>[] = [];

  /** Override per test to simulate provider failure. */
  public createMultipartUploadImpl?: (
    opts: CreateMultipartUploadOptions,
  ) => Promise<MultipartUploadHandle>;
  public createSingleUploadUrlImpl?: (
    opts: CreateSingleUploadUrlOptions,
  ) => Promise<SingleUploadUrl>;
  public signMultipartPartImpl?: (opts: SignMultipartPartOptions) => Promise<MultipartPartUrl>;
  public completeMultipartUploadImpl?: (
    opts: CompleteMultipartUploadOptions,
  ) => Promise<CompleteMultipartUploadResult>;
  public abortMultipartUploadImpl?: (opts: AbortMultipartUploadOptions) => Promise<void>;
  public headObjectImpl?: (opts: HeadObjectOptions) => Promise<HeadObjectResult>;
  public createDownloadUrlImpl?: (opts: CreateDownloadUrlOptions) => Promise<DownloadUrl>;
  public deleteObjectImpl?: (opts: DeleteObjectOptions) => Promise<void>;

  // STORAGE-FU-5 — server-side I/O methods. Tests that exercise the
  // runner pipeline through the real adapter contract may set the
  // `*Impl` overrides; otherwise a deterministic empty/byte payload
  // is returned so contract-level tests pass.
  public getObjectBytesImpl?: (opts: { objectKey: string }) => Promise<Uint8Array>;
  public putObjectBytesImpl?: (opts: {
    objectKey: string;
    body: Uint8Array;
    contentType: string;
    ifAbsent?: boolean;
  }) => Promise<{ byteSize: number }>;

  constructor(providerKind: ProviderKind = 'r2') {
    this.providerKind = providerKind;
  }

  async createSingleUploadUrl(opts: CreateSingleUploadUrlOptions): Promise<SingleUploadUrl> {
    this.calls.push({ method: 'createSingleUploadUrl', opts });
    if (this.createSingleUploadUrlImpl) return this.createSingleUploadUrlImpl(opts);
    return {
      url: `https://${this.endpointHost}/${this.bucket}/${opts.objectKey}?X-Amz-Signature=FAKE_SIG`,
      headers: opts.contentType ? { 'content-type': opts.contentType } : {},
      expiresAt: new Date(Date.now() + (opts.expiresInSeconds ?? 900) * 1000),
    };
  }

  async createMultipartUpload(opts: CreateMultipartUploadOptions): Promise<MultipartUploadHandle> {
    this.calls.push({ method: 'createMultipartUpload', opts });
    if (this.createMultipartUploadImpl) return this.createMultipartUploadImpl(opts);
    return { objectKey: opts.objectKey, providerUploadId: 'fake-multipart-upload-id' };
  }

  async signMultipartPart(opts: SignMultipartPartOptions): Promise<MultipartPartUrl> {
    this.calls.push({ method: 'signMultipartPart', opts });
    if (this.signMultipartPartImpl) return this.signMultipartPartImpl(opts);
    return {
      partNumber: opts.partNumber,
      url: `https://${this.endpointHost}/${this.bucket}/${opts.objectKey}?partNumber=${opts.partNumber}&X-Amz-Signature=FAKE_SIG`,
      expiresAt: new Date(Date.now() + (opts.expiresInSeconds ?? 900) * 1000),
    };
  }

  async completeMultipartUpload(
    opts: CompleteMultipartUploadOptions,
  ): Promise<CompleteMultipartUploadResult> {
    this.calls.push({ method: 'completeMultipartUpload', opts });
    if (this.completeMultipartUploadImpl) return this.completeMultipartUploadImpl(opts);
    return { objectKey: opts.objectKey, etag: '"fake-etag"' };
  }

  async abortMultipartUpload(opts: AbortMultipartUploadOptions): Promise<void> {
    this.calls.push({ method: 'abortMultipartUpload', opts });
    if (this.abortMultipartUploadImpl) return this.abortMultipartUploadImpl(opts);
  }

  async headObject(opts: HeadObjectOptions): Promise<HeadObjectResult> {
    this.calls.push({ method: 'headObject', opts });
    if (this.headObjectImpl) return this.headObjectImpl(opts);
    return {
      objectKey: opts.objectKey,
      contentLength: 4096,
      contentType: 'application/octet-stream',
      etag: '"fake-etag"',
      lastModified: new Date(),
    };
  }

  async createDownloadUrl(opts: CreateDownloadUrlOptions): Promise<DownloadUrl> {
    this.calls.push({ method: 'createDownloadUrl', opts });
    if (this.createDownloadUrlImpl) return this.createDownloadUrlImpl(opts);
    return {
      url: `https://${this.endpointHost}/${this.bucket}/${opts.objectKey}?X-Amz-Signature=FAKE_SIG`,
      expiresAt: new Date(Date.now() + (opts.expiresInSeconds ?? 900) * 1000),
    };
  }

  async deleteObject(opts: DeleteObjectOptions): Promise<void> {
    this.calls.push({ method: 'deleteObject', opts });
    if (this.deleteObjectImpl) return this.deleteObjectImpl(opts);
  }

  async getObjectBytes(opts: { objectKey: string }): Promise<Uint8Array> {
    this.calls.push({ method: 'getObjectBytes', opts });
    if (this.getObjectBytesImpl) return this.getObjectBytesImpl(opts);
    return new Uint8Array();
  }

  async putObjectBytes(opts: {
    objectKey: string;
    body: Uint8Array;
    contentType: string;
    ifAbsent?: boolean;
  }): Promise<{ byteSize: number }> {
    this.calls.push({ method: 'putObjectBytes', opts });
    if (this.putObjectBytesImpl) return this.putObjectBytesImpl(opts);
    return { byteSize: opts.body.byteLength };
  }
}

export class FakeProviderResolver implements StorageProviderResolver {
  public readonly adapter: FakeStorageAdapter;
  public readonly providerId: string;
  public resolveCount = 0;
  /** When true, `resolveDefaultForWorkspace` returns null. */
  public unconfigured = false;

  constructor(
    options: {
      providerId?: string;
      providerKind?: ProviderKind;
      adapter?: FakeStorageAdapter;
    } = {},
  ) {
    this.providerId = options.providerId ?? '00000000-0000-4000-8000-0000000000a0';
    this.adapter = options.adapter ?? new FakeStorageAdapter(options.providerKind);
  }

  async resolveDefaultForWorkspace(_workspaceId: string): Promise<ResolvedProvider | null> {
    this.resolveCount += 1;
    if (this.unconfigured) return null;
    return {
      providerId: this.providerId,
      providerKind: this.adapter.providerKind,
      adapter: this.adapter,
    };
  }
}

interface InMemoryState {
  objects: Map<string, StorageObjectRecord>;
  sessions: Map<string, UploadSessionRecord>;
}

function makeState(): InMemoryState {
  return { objects: new Map(), sessions: new Map() };
}

export class FakeRepositories {
  private readonly state: InMemoryState = makeState();
  /** When set, `createObjectWithSession` throws this once. */
  public throwOnCreateOnce?: Error;
  /** When set, `markCompletedIfPending` returns null even when the row is pending. */
  public failConditionalComplete = false;
  /** When set, `markAbortedIfPending` returns null even when the row is pending. */
  public failConditionalAbort = false;

  readonly objects: StorageObjectRepository = {
    findByIdForWorkspace: async ({ objectId, workspaceId }) => {
      const o = this.state.objects.get(objectId);
      if (!o || o.workspaceId !== workspaceId) return null;
      return o;
    },
    markUploaded: async ({ objectId, workspaceId, sha256 }) => {
      const o = this.state.objects.get(objectId);
      if (!o || o.workspaceId !== workspaceId) return null;
      const updated: StorageObjectRecord = {
        ...o,
        status: o.status === 'uploaded' ? 'uploaded' : 'uploaded',
        sha256: sha256 ?? o.sha256,
        uploadedAt: o.uploadedAt ?? new Date(),
        updatedAt: new Date(),
      };
      this.state.objects.set(objectId, updated);
      return updated;
    },
  };

  readonly sessions: UploadSessionRepository = {
    createObjectWithSession: async (input: CreateObjectWithSessionInput) => {
      if (this.throwOnCreateOnce) {
        const err = this.throwOnCreateOnce;
        this.throwOnCreateOnce = undefined;
        throw err;
      }
      const now = new Date();
      const obj: StorageObjectRecord = {
        id: input.objectId,
        workspaceId: input.workspaceId,
        providerId: input.providerId,
        providerObjectKey: input.providerObjectKey,
        filename: input.filename,
        contentType: input.contentType,
        byteSize: input.byteSize,
        sha256: input.sha256,
        purpose: input.purpose,
        visibility: input.visibility,
        status: 'pending_upload',
        compressionRequested: input.compressionRequested,
        createdBy: input.createdBy,
        createdAt: now,
        updatedAt: now,
        uploadedAt: null,
      };
      const sess: UploadSessionRecord = {
        id: input.sessionId,
        workspaceId: input.workspaceId,
        objectId: input.objectId,
        uploadMethod: input.uploadMethod,
        providerUploadId: input.providerUploadId,
        status: 'pending',
        createdAt: now,
        expiresAt: input.expiresAt,
        completedAt: null,
        abortedAt: null,
        createdBy: input.createdBy,
      };
      this.state.objects.set(obj.id, obj);
      this.state.sessions.set(sess.id, sess);
      return { object: obj, session: sess } satisfies CreateObjectWithSessionResult;
    },
    findByIdForWorkspace: async ({ sessionId, workspaceId }) => {
      const s = this.state.sessions.get(sessionId);
      if (!s || s.workspaceId !== workspaceId) return null;
      return s;
    },
    markCompletedIfPending: async ({ sessionId, workspaceId, now }) => {
      if (this.failConditionalComplete) return null;
      const s = this.state.sessions.get(sessionId);
      if (!s || s.workspaceId !== workspaceId) return null;
      if (s.status !== 'pending') return null;
      if (s.expiresAt.getTime() <= now.getTime()) return null;
      const updated: UploadSessionRecord = { ...s, status: 'completed', completedAt: now };
      this.state.sessions.set(sessionId, updated);
      return updated;
    },
    markAbortedIfPending: async ({ sessionId, workspaceId, now }) => {
      if (this.failConditionalAbort) return null;
      const s = this.state.sessions.get(sessionId);
      if (!s || s.workspaceId !== workspaceId) return null;
      if (s.status !== 'pending') return null;
      const updated: UploadSessionRecord = { ...s, status: 'aborted', abortedAt: now };
      this.state.sessions.set(sessionId, updated);
      return updated;
    },
  };

  /** Test helper: directly seed a session row (for state-transition tests). */
  seedSession(session: UploadSessionRecord, object: StorageObjectRecord): void {
    this.state.sessions.set(session.id, session);
    this.state.objects.set(object.id, object);
  }

  /** Test helper: mutate a session's state directly. */
  setSessionStatus(sessionId: string, status: UploadSessionRecord['status']): void {
    const s = this.state.sessions.get(sessionId);
    if (!s) return;
    this.state.sessions.set(sessionId, { ...s, status });
  }

  /** Test helper: read the current session row. */
  getSession(sessionId: string): UploadSessionRecord | undefined {
    return this.state.sessions.get(sessionId);
  }

  /** Test helper: read the current object row. */
  getObject(objectId: string): StorageObjectRecord | undefined {
    return this.state.objects.get(objectId);
  }

  /** Test helper: forcibly delete the object row (simulate FK breach). */
  forceDeleteObject(objectId: string): void {
    this.state.objects.delete(objectId);
  }
}

export const TEST_WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';
export const TEST_USER_ID = '00000000-0000-4000-8000-000000000002';
export const TEST_API_KEY_ID = '00000000-0000-4000-8000-000000000003';

/** Build a user `ActionContext`. */
export function makeUserCtx(
  overrides: Partial<{ workspaceId: string; userId: string; requestId: string }> = {},
) {
  const workspaceId = overrides.workspaceId ?? TEST_WORKSPACE_ID;
  const userId = overrides.userId ?? TEST_USER_ID;
  return {
    workspaceId,
    requestId: overrides.requestId ?? 'req-test',
    actor: { kind: 'user' as const, userId },
    userId,
  };
}

export function makeApiKeyCtx(
  overrides: Partial<{ workspaceId: string; apiKeyId: string; keyPrefix: string }> = {},
) {
  const workspaceId = overrides.workspaceId ?? TEST_WORKSPACE_ID;
  return {
    workspaceId,
    requestId: 'req-test',
    actor: {
      kind: 'api_key' as const,
      apiKeyId: overrides.apiKeyId ?? TEST_API_KEY_ID,
      keyPrefix: overrides.keyPrefix ?? 'aabbccdd',
    },
  };
}

/**
 * Deterministic id factory — yields predictable UUIDs so tests can assert
 * on `objectId` / `sessionId` directly.
 */
export function makeDeterministicIds(): { next: () => string; ids: string[] } {
  const ids: string[] = [];
  let i = 0;
  return {
    next: () => {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      i += 1;
      ids.push(id);
      return id;
    },
    ids,
  };
}

/** Build a fully-stubbed `UploadHandlerDependencies` for happy-path tests. */
export function makeDeps(
  overrides: Partial<{
    multipartThresholdBytes: number;
    sessionTtlSeconds: number;
    now: () => Date;
    repositories: FakeRepositories;
    providers: FakeProviderResolver;
    idFactory: () => string;
  }> = {},
): UploadHandlerDependencies & {
  repositories: FakeRepositories;
  providers: FakeProviderResolver;
} {
  const repositories = overrides.repositories ?? new FakeRepositories();
  const providers = overrides.providers ?? new FakeProviderResolver();
  return {
    objects: repositories.objects,
    sessions: repositories.sessions,
    providers,
    now: overrides.now,
    idFactory: overrides.idFactory ?? makeDeterministicIds().next,
    sessionTtlSeconds: overrides.sessionTtlSeconds,
    multipartThresholdBytes: overrides.multipartThresholdBytes,
    repositories,
  };
}
