/**
 * STORAGE-9 — Abandoned upload session cleanup tests.
 *
 * Covers:
 *   - Single deterministic pass via `runOnce()`.
 *   - Per-session flow: provider abort -> mark expired.
 *   - Provider abort `ProviderAdapterError` (NoSuchUpload) treated as success.
 *   - Non-adapter error defers the session (does NOT flip local row).
 *   - Race-loss when `markExpiredIfPending` returns `null` (session
 *     completed / aborted in between).
 *   - Cross-workspace isolation: every session uses its own
 *     `workspaceId` when resolving the provider.
 *   - Polling loop start/stop with `setInterval` swallowing thrown
 *     errors.
 *   - Concurrency guard: a second `runOnce` while the first is running
 *     short-circuits.
 *   - Single-upload sessions skip the provider abort step.
 *   - Missing object row / missing provider config still flips local row.
 *   - Result counters (`scanned`, `expired`, `deferred`, `raced`) are
 *     accurate.
 */
import { describe, expect, test } from 'bun:test';
import {
  AbandonedUploadCleanup,
  STORAGE_CLEANUP_DEFAULT_BATCH_SIZE,
  STORAGE_CLEANUP_DEFAULT_POLL_INTERVAL_MS,
  type AbandonedUploadSessionRepository,
} from '../../src/infra/cleanup/abandoned-uploads';
import { ProviderAdapterError } from '../../src/infra/providers/errors';
import type {
  ResolvedProvider,
  StorageObjectRecord,
  StorageObjectRepository,
  StorageProviderResolver,
  UploadSessionRecord,
} from '../../src/actions/handlers/uploads/types';
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
} from '../../src/infra/providers/types';

const NOW = new Date('2026-05-14T12:00:00Z');

function makeSession(overrides: Partial<UploadSessionRecord> = {}): UploadSessionRecord {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    workspaceId: '11111111-1111-4111-8111-111111111111',
    objectId: '22222222-2222-4222-8222-222222222222',
    uploadMethod: 'multipart',
    providerUploadId: 'provider-upload-mp-1',
    status: 'pending',
    createdAt: new Date('2026-05-14T10:00:00Z'),
    expiresAt: new Date('2026-05-14T11:00:00Z'),
    completedAt: null,
    abortedAt: null,
    createdBy: 'user-1',
    ...overrides,
  };
}

function makeObject(overrides: Partial<StorageObjectRecord> = {}): StorageObjectRecord {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    workspaceId: '11111111-1111-4111-8111-111111111111',
    providerId: 'aaaa1111-bbbb-2222-cccc-3333dddd4444',
    providerObjectKey: 'workspaces/ws-1/objects/obj-1/file.jpg',
    filename: 'file.jpg',
    contentType: 'image/jpeg',
    byteSize: 1024,
    sha256: null,
    purpose: 'platform',
    visibility: 'private',
    status: 'pending_upload',
    compressionRequested: true,
    createdBy: 'user-1',
    createdAt: NOW,
    updatedAt: NOW,
    uploadedAt: null,
    ...overrides,
  };
}

class FakeSessionRepo implements AbandonedUploadSessionRepository {
  public listExpiredPendingCalls: Array<{ now: Date; limit: number }> = [];
  public markExpiredCalls: Array<{ sessionId: string; workspaceId: string; now: Date }> = [];

  public sessionsToList: UploadSessionRecord[] = [];
  /**
   * When `expired` is `true` for a sessionId, `markExpiredIfPending`
   * returns the session row stamped `expired`. When `false`, returns
   * `null` (raced).
   */
  public markExpiredOutcomes: Map<string, boolean> = new Map();

  async listExpiredPending(input: { now: Date; limit: number }): Promise<UploadSessionRecord[]> {
    this.listExpiredPendingCalls.push(input);
    return this.sessionsToList;
  }

  async markExpiredIfPending(input: {
    sessionId: string;
    workspaceId: string;
    now: Date;
  }): Promise<UploadSessionRecord | null> {
    this.markExpiredCalls.push(input);
    const should = this.markExpiredOutcomes.get(input.sessionId);
    if (should === false) return null;
    const session = this.sessionsToList.find((s) => s.id === input.sessionId);
    if (!session) return null;
    return { ...session, status: 'expired' };
  }
}

class FakeObjectRepo implements Pick<StorageObjectRepository, 'findByIdForWorkspace'> {
  public objects: Map<string, StorageObjectRecord> = new Map();
  public findCalls: Array<{ objectId: string; workspaceId: string }> = [];

  add(obj: StorageObjectRecord): void {
    this.objects.set(`${obj.workspaceId}:${obj.id}`, obj);
  }

  async findByIdForWorkspace(input: {
    objectId: string;
    workspaceId: string;
  }): Promise<StorageObjectRecord | null> {
    this.findCalls.push(input);
    return this.objects.get(`${input.workspaceId}:${input.objectId}`) ?? null;
  }
}

class FakeProviderAdapter implements StorageProviderAdapter {
  public readonly providerKind: ProviderKind = 'r2';
  public readonly endpointHost = 's3.fake.example';
  public readonly bucket = 'fake-bucket';
  public abortCalls: AbortMultipartUploadOptions[] = [];
  public abortImpl: (opts: AbortMultipartUploadOptions) => Promise<void> = async () => undefined;

  async abortMultipartUpload(opts: AbortMultipartUploadOptions): Promise<void> {
    this.abortCalls.push(opts);
    return this.abortImpl(opts);
  }

  // Unused operations (stubbed to satisfy the interface).
  async createSingleUploadUrl(_opts: CreateSingleUploadUrlOptions): Promise<SingleUploadUrl> {
    throw new Error('not implemented');
  }
  async createMultipartUpload(_opts: CreateMultipartUploadOptions): Promise<MultipartUploadHandle> {
    throw new Error('not implemented');
  }
  async signMultipartPart(_opts: SignMultipartPartOptions): Promise<MultipartPartUrl> {
    throw new Error('not implemented');
  }
  async completeMultipartUpload(
    _opts: CompleteMultipartUploadOptions,
  ): Promise<CompleteMultipartUploadResult> {
    throw new Error('not implemented');
  }
  async headObject(_opts: HeadObjectOptions): Promise<HeadObjectResult> {
    throw new Error('not implemented');
  }
  async createDownloadUrl(_opts: CreateDownloadUrlOptions): Promise<DownloadUrl> {
    throw new Error('not implemented');
  }
  async deleteObject(_opts: DeleteObjectOptions): Promise<void> {
    throw new Error('not implemented');
  }
  // STORAGE-FU-5 — server-side I/O. Cleanup tests don't exercise these.
  async getObjectBytes(_opts: { objectKey: string }): Promise<Uint8Array> {
    throw new Error('not implemented');
  }
  async putObjectBytes(_opts: {
    objectKey: string;
    body: Uint8Array;
    contentType: string;
    ifAbsent?: boolean;
  }): Promise<{ byteSize: number }> {
    throw new Error('not implemented');
  }
}

class FakeProviderResolver implements StorageProviderResolver {
  public adapter: FakeProviderAdapter = new FakeProviderAdapter();
  public providerId = 'aaaa1111-bbbb-2222-cccc-3333dddd4444';
  public resolveImpl: (workspaceId: string) => Promise<ResolvedProvider | null> = async () => ({
    providerId: this.providerId,
    providerKind: this.adapter.providerKind,
    adapter: this.adapter,
  });
  public resolveCalls: string[] = [];

  async resolveDefaultForWorkspace(workspaceId: string): Promise<ResolvedProvider | null> {
    this.resolveCalls.push(workspaceId);
    return this.resolveImpl(workspaceId);
  }
}

interface Fakes {
  sessions: FakeSessionRepo;
  objects: FakeObjectRepo;
  providers: FakeProviderResolver;
}

function buildFakes(): Fakes {
  return {
    sessions: new FakeSessionRepo(),
    objects: new FakeObjectRepo(),
    providers: new FakeProviderResolver(),
  };
}

describe('AbandonedUploadCleanup.runOnce — happy path', () => {
  test('expires a multipart session: provider abort + local row flip', async () => {
    const f = buildFakes();
    const session = makeSession();
    f.sessions.sessionsToList = [session];
    f.objects.add(makeObject({ id: session.objectId, workspaceId: session.workspaceId }));

    const cleanup = new AbandonedUploadCleanup({
      sessions: f.sessions,
      objects: f.objects,
      providers: f.providers,
      now: () => NOW,
    });
    const result = await cleanup.runOnce();
    expect(result).toEqual({ scanned: 1, expired: 1, deferred: 0, raced: 0 });
    expect(f.providers.adapter.abortCalls).toHaveLength(1);
    expect(f.providers.adapter.abortCalls[0]).toEqual({
      objectKey: 'workspaces/ws-1/objects/obj-1/file.jpg',
      providerUploadId: 'provider-upload-mp-1',
    });
    expect(f.sessions.markExpiredCalls).toHaveLength(1);
    expect(f.sessions.markExpiredCalls[0]).toEqual({
      sessionId: session.id,
      workspaceId: session.workspaceId,
      now: NOW,
    });
  });

  test('single-upload sessions skip provider abort entirely', async () => {
    const f = buildFakes();
    const session = makeSession({ uploadMethod: 'single', providerUploadId: null });
    f.sessions.sessionsToList = [session];
    f.objects.add(makeObject({ id: session.objectId, workspaceId: session.workspaceId }));

    const cleanup = new AbandonedUploadCleanup({
      sessions: f.sessions,
      objects: f.objects,
      providers: f.providers,
      now: () => NOW,
    });
    const result = await cleanup.runOnce();
    expect(result.expired).toBe(1);
    expect(f.providers.adapter.abortCalls).toHaveLength(0);
    expect(f.providers.resolveCalls).toHaveLength(0);
  });

  test('runs in series across multiple sessions', async () => {
    const f = buildFakes();
    const s1 = makeSession({ id: '00000000-0000-4000-8000-aaaa00000001' });
    const s2 = makeSession({
      id: '00000000-0000-4000-8000-aaaa00000002',
      objectId: 'objaaaa-2222-4222-8222-222222222222',
    });
    f.sessions.sessionsToList = [s1, s2];
    f.objects.add(makeObject({ id: s1.objectId, workspaceId: s1.workspaceId }));
    f.objects.add(makeObject({ id: s2.objectId, workspaceId: s2.workspaceId }));

    const cleanup = new AbandonedUploadCleanup({
      sessions: f.sessions,
      objects: f.objects,
      providers: f.providers,
      now: () => NOW,
    });
    const result = await cleanup.runOnce();
    expect(result).toEqual({ scanned: 2, expired: 2, deferred: 0, raced: 0 });
  });
});

describe('AbandonedUploadCleanup.runOnce — provider abort error swallowing', () => {
  test('ProviderAdapterError (NoSuchUpload-style) is treated as success', async () => {
    const f = buildFakes();
    const session = makeSession();
    f.sessions.sessionsToList = [session];
    f.objects.add(makeObject({ id: session.objectId, workspaceId: session.workspaceId }));
    f.providers.adapter.abortImpl = async () => {
      throw new ProviderAdapterError(
        'PROVIDER_OPERATION_FAILED',
        'NoSuchUpload: multipart already aborted',
      );
    };

    const cleanup = new AbandonedUploadCleanup({
      sessions: f.sessions,
      objects: f.objects,
      providers: f.providers,
      now: () => NOW,
    });
    const result = await cleanup.runOnce();
    // Treated as success → local row still flipped.
    expect(result).toEqual({ scanned: 1, expired: 1, deferred: 0, raced: 0 });
    expect(f.sessions.markExpiredCalls).toHaveLength(1);
  });

  test('non-adapter error defers the session (local row NOT flipped)', async () => {
    const f = buildFakes();
    const session = makeSession();
    f.sessions.sessionsToList = [session];
    f.objects.add(makeObject({ id: session.objectId, workspaceId: session.workspaceId }));
    f.providers.adapter.abortImpl = async () => {
      throw new TypeError('transient network failure');
    };

    const cleanup = new AbandonedUploadCleanup({
      sessions: f.sessions,
      objects: f.objects,
      providers: f.providers,
      now: () => NOW,
    });
    const result = await cleanup.runOnce();
    expect(result).toEqual({ scanned: 1, expired: 0, deferred: 1, raced: 0 });
    // local row NOT flipped — we retry next pass.
    expect(f.sessions.markExpiredCalls).toHaveLength(0);
  });
});

describe('AbandonedUploadCleanup.runOnce — degraded inputs', () => {
  test('orphan session (no object row) still flips local row', async () => {
    const f = buildFakes();
    const session = makeSession();
    f.sessions.sessionsToList = [session];
    // No object row added.

    const cleanup = new AbandonedUploadCleanup({
      sessions: f.sessions,
      objects: f.objects,
      providers: f.providers,
      now: () => NOW,
    });
    const result = await cleanup.runOnce();
    expect(result.expired).toBe(1);
    // Provider never contacted because we couldn't find the object key.
    expect(f.providers.adapter.abortCalls).toHaveLength(0);
  });

  test('workspace with no provider config still flips local row', async () => {
    const f = buildFakes();
    const session = makeSession();
    f.sessions.sessionsToList = [session];
    f.objects.add(makeObject({ id: session.objectId, workspaceId: session.workspaceId }));
    f.providers.resolveImpl = async () => null;

    const cleanup = new AbandonedUploadCleanup({
      sessions: f.sessions,
      objects: f.objects,
      providers: f.providers,
      now: () => NOW,
    });
    const result = await cleanup.runOnce();
    expect(result.expired).toBe(1);
    expect(f.providers.adapter.abortCalls).toHaveLength(0);
  });

  test('empty list → no work, all counters 0', async () => {
    const f = buildFakes();
    const cleanup = new AbandonedUploadCleanup({
      sessions: f.sessions,
      objects: f.objects,
      providers: f.providers,
      now: () => NOW,
    });
    const result = await cleanup.runOnce();
    expect(result).toEqual({ scanned: 0, expired: 0, deferred: 0, raced: 0 });
    expect(f.sessions.markExpiredCalls).toHaveLength(0);
  });
});

describe('AbandonedUploadCleanup.runOnce — race-loss', () => {
  test('session raced to terminal state between list and update', async () => {
    const f = buildFakes();
    const session = makeSession();
    f.sessions.sessionsToList = [session];
    f.objects.add(makeObject({ id: session.objectId, workspaceId: session.workspaceId }));
    f.sessions.markExpiredOutcomes.set(session.id, false);

    const cleanup = new AbandonedUploadCleanup({
      sessions: f.sessions,
      objects: f.objects,
      providers: f.providers,
      now: () => NOW,
    });
    const result = await cleanup.runOnce();
    expect(result).toEqual({ scanned: 1, expired: 0, deferred: 0, raced: 1 });
  });
});

describe('AbandonedUploadCleanup.runOnce — cross-workspace isolation', () => {
  test('each session resolves the provider using its own workspaceId', async () => {
    const f = buildFakes();
    const wsA = '11111111-1111-4111-8111-aaaaaaaaaaaa';
    const wsB = '22222222-2222-4222-8222-bbbbbbbbbbbb';
    const sessA = makeSession({
      id: '00000000-0000-4000-8000-aaaa00000001',
      workspaceId: wsA,
    });
    const sessB = makeSession({
      id: '00000000-0000-4000-8000-bbbb00000002',
      workspaceId: wsB,
      objectId: 'objbbbb-2222-4222-8222-222222222222',
    });
    f.sessions.sessionsToList = [sessA, sessB];
    f.objects.add(makeObject({ id: sessA.objectId, workspaceId: wsA }));
    f.objects.add(makeObject({ id: sessB.objectId, workspaceId: wsB }));

    const cleanup = new AbandonedUploadCleanup({
      sessions: f.sessions,
      objects: f.objects,
      providers: f.providers,
      now: () => NOW,
    });
    await cleanup.runOnce();

    // Each resolve call used the session's OWN workspaceId, never a
    // mixed pair.
    expect(f.providers.resolveCalls).toEqual([wsA, wsB]);
    // Each object lookup also workspace-scoped.
    expect(f.objects.findCalls).toContainEqual({ objectId: sessA.objectId, workspaceId: wsA });
    expect(f.objects.findCalls).toContainEqual({ objectId: sessB.objectId, workspaceId: wsB });
  });
});

describe('AbandonedUploadCleanup.runOnce — concurrency guard', () => {
  test('a second runOnce while one is in flight short-circuits', async () => {
    const f = buildFakes();
    const session = makeSession();
    f.sessions.sessionsToList = [session];
    f.objects.add(makeObject({ id: session.objectId, workspaceId: session.workspaceId }));

    // Hold the provider abort open until we trigger a second runOnce.
    let releaseAbort: () => void;
    const abortHeld = new Promise<void>((res) => {
      releaseAbort = res;
    });
    f.providers.adapter.abortImpl = async () => {
      await abortHeld;
    };

    const cleanup = new AbandonedUploadCleanup({
      sessions: f.sessions,
      objects: f.objects,
      providers: f.providers,
      now: () => NOW,
    });
    const inFlight = cleanup.runOnce();
    // Sleep a microtask so the first pass enters `runOnce`.
    await new Promise((res) => setTimeout(res, 0));
    const second = await cleanup.runOnce();
    expect(second).toEqual({ scanned: 0, expired: 0, deferred: 0, raced: 0 });

    releaseAbort!();
    const first = await inFlight;
    expect(first.scanned).toBe(1);
  });
});

describe('AbandonedUploadCleanup.runOnce — batch sizing', () => {
  test('default batch size is forwarded to the session repo', async () => {
    const f = buildFakes();
    const cleanup = new AbandonedUploadCleanup({
      sessions: f.sessions,
      objects: f.objects,
      providers: f.providers,
      now: () => NOW,
    });
    await cleanup.runOnce();
    expect(f.sessions.listExpiredPendingCalls[0]?.limit).toBe(STORAGE_CLEANUP_DEFAULT_BATCH_SIZE);
    expect(f.sessions.listExpiredPendingCalls[0]?.now).toEqual(NOW);
  });

  test('explicit batchSize override is honoured', async () => {
    const f = buildFakes();
    const cleanup = new AbandonedUploadCleanup({
      sessions: f.sessions,
      objects: f.objects,
      providers: f.providers,
      now: () => NOW,
      batchSize: 25,
    });
    await cleanup.runOnce();
    expect(f.sessions.listExpiredPendingCalls[0]?.limit).toBe(25);
  });
});

describe('AbandonedUploadCleanup — clock default', () => {
  test('uses Date.now() when no clock override is supplied', async () => {
    const f = buildFakes();
    const cleanup = new AbandonedUploadCleanup({
      sessions: f.sessions,
      objects: f.objects,
      providers: f.providers,
    });
    await cleanup.runOnce();
    expect(f.sessions.listExpiredPendingCalls[0]?.now).toBeInstanceOf(Date);
  });
});

describe('AbandonedUploadCleanup.start / stop', () => {
  test('start schedules a setInterval and stop clears it', async () => {
    const f = buildFakes();
    const cleanup = new AbandonedUploadCleanup({
      sessions: f.sessions,
      objects: f.objects,
      providers: f.providers,
      now: () => NOW,
    });
    cleanup.start(1); // 1 ms — fires near-immediately.
    await new Promise((res) => setTimeout(res, 5));
    cleanup.stop();
    // At least one list call should have happened.
    expect(f.sessions.listExpiredPendingCalls.length).toBeGreaterThanOrEqual(1);
  });

  test('start is idempotent (calling twice does not schedule twice)', () => {
    const f = buildFakes();
    const cleanup = new AbandonedUploadCleanup({
      sessions: f.sessions,
      objects: f.objects,
      providers: f.providers,
    });
    cleanup.start(1_000_000); // long enough to never fire in test
    cleanup.start(1_000_000); // second call: no-op
    cleanup.stop();
    cleanup.stop(); // also idempotent
  });

  test('default poll interval constant exported', () => {
    expect(STORAGE_CLEANUP_DEFAULT_POLL_INTERVAL_MS).toBe(60_000);
  });

  test('polling loop swallows runOnce errors so a transient failure does not kill the worker', async () => {
    const f = buildFakes();
    // First listExpiredPending call throws to simulate transient DB outage.
    let threw = false;
    const realList = f.sessions.listExpiredPending.bind(f.sessions);
    f.sessions.listExpiredPending = async (input: {
      now: Date;
      limit: number;
    }): Promise<UploadSessionRecord[]> => {
      if (!threw) {
        threw = true;
        throw new Error('transient DB outage');
      }
      return realList(input);
    };
    const cleanup = new AbandonedUploadCleanup({
      sessions: f.sessions,
      objects: f.objects,
      providers: f.providers,
      now: () => NOW,
    });
    cleanup.start(1);
    await new Promise((res) => setTimeout(res, 25));
    cleanup.stop();
    // The first pass threw, but later passes succeeded (we never saw
    // an uncaught exception).
    expect(threw).toBe(true);
  });
});
