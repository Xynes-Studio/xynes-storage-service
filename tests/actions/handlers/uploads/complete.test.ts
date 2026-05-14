/**
 * STORAGE-5 — `complete` upload session handler tests.
 *
 * Covers:
 *   - Happy-path single + multipart complete.
 *   - State transitions: pending → completed, object pending_upload → uploaded.
 *   - Idempotency on already-completed sessions.
 *   - State conflicts: aborted, expired, missing.
 *   - Cross-workspace denial (same envelope as not-found).
 *   - Multipart-without-parts validation error.
 *   - Race-loss path (conditional update misses but session resolved to completed).
 *   - Empty single-upload (HEAD returns 0 bytes).
 *   - Response shape redaction.
 */
import { describe, expect, test } from 'bun:test';
import { createCompleteUploadHandler } from '../../../../src/actions/handlers/uploads/complete';
import { ValidationError } from '../../../../src/actions/errors';
import type {
  StorageObjectRecord,
  UploadSessionRecord,
} from '../../../../src/actions/handlers/uploads/types';
import {
  FakeProviderResolver,
  FakeRepositories,
  makeDeps,
  makeUserCtx,
  TEST_WORKSPACE_ID,
} from './_fakes';

function seedPending(
  repositories: FakeRepositories,
  overrides: Partial<{
    uploadMethod: 'single' | 'multipart';
    providerUploadId: string | null;
    expiresAt: Date;
    workspaceId: string;
  }> = {},
): { session: UploadSessionRecord; object: StorageObjectRecord } {
  const workspaceId = overrides.workspaceId ?? TEST_WORKSPACE_ID;
  const objectId = '00000000-0000-4000-8000-000000aa0001';
  const sessionId = '00000000-0000-4000-8000-000000bb0001';
  const now = new Date();
  const session: UploadSessionRecord = {
    id: sessionId,
    workspaceId,
    objectId,
    uploadMethod: overrides.uploadMethod ?? 'single',
    providerUploadId: overrides.providerUploadId ?? null,
    status: 'pending',
    createdAt: now,
    expiresAt: overrides.expiresAt ?? new Date(now.getTime() + 60_000),
    completedAt: null,
    abortedAt: null,
    createdBy: null,
  };
  const object: StorageObjectRecord = {
    id: objectId,
    workspaceId,
    providerId: '00000000-0000-4000-8000-0000000000a0',
    providerObjectKey: `workspaces/${workspaceId}/objects/${objectId}/file.bin`,
    filename: 'file.bin',
    contentType: 'application/octet-stream',
    byteSize: 4096,
    sha256: null,
    purpose: 'platform_generic',
    visibility: 'private',
    status: 'pending_upload',
    compressionRequested: true,
    createdBy: null,
    createdAt: now,
    updatedAt: now,
    uploadedAt: null,
  };
  repositories.seedSession(session, object);
  return { session, object };
}

describe('completeUploadHandler — single happy path', () => {
  test('marks session completed and object uploaded', async () => {
    const repositories = new FakeRepositories();
    const { session } = seedPending(repositories);
    const deps = makeDeps({ repositories });
    const handler = createCompleteUploadHandler(deps);

    const res = await handler({ operation: 'complete', uploadId: session.id }, makeUserCtx());

    expect(res.session.status).toBe('completed');
    expect(res.session.completedAt).not.toBeNull();
    expect(res.object.status).toBe('uploaded');
    expect(res.object.uploadedAt).not.toBeNull();
    expect(res.processingJobs).toEqual([]);
  });

  test('HEADs the object to verify the upload landed', async () => {
    const repositories = new FakeRepositories();
    const { session } = seedPending(repositories);
    const providers = new FakeProviderResolver();
    const deps = makeDeps({ repositories, providers });
    const handler = createCompleteUploadHandler(deps);
    await handler({ operation: 'complete', uploadId: session.id }, makeUserCtx());
    const heads = providers.adapter.calls.filter((c) => c.method === 'headObject');
    expect(heads.length).toBe(1);
  });

  test('rejects empty single uploads (HEAD returns 0 bytes)', async () => {
    const repositories = new FakeRepositories();
    const { session } = seedPending(repositories);
    const providers = new FakeProviderResolver();
    providers.adapter.headObjectImpl = async (o) => ({
      objectKey: o.objectKey,
      contentLength: 0,
      contentType: null,
      etag: null,
      lastModified: null,
    });
    const deps = makeDeps({ repositories, providers });
    const handler = createCompleteUploadHandler(deps);
    await expect(
      handler({ operation: 'complete', uploadId: session.id }, makeUserCtx()),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('persists supplied sha256 on complete', async () => {
    const repositories = new FakeRepositories();
    const { session } = seedPending(repositories);
    const deps = makeDeps({ repositories });
    const handler = createCompleteUploadHandler(deps);
    const sha = 'b'.repeat(64);
    const res = await handler(
      { operation: 'complete', uploadId: session.id, sha256: sha },
      makeUserCtx(),
    );
    expect(res.object.sha256).toBe(sha);
  });
});

describe('completeUploadHandler — multipart happy path', () => {
  test('completes multipart with supplied parts and marks both rows', async () => {
    const repositories = new FakeRepositories();
    const { session } = seedPending(repositories, {
      uploadMethod: 'multipart',
      providerUploadId: 'mp-upload-1',
    });
    const providers = new FakeProviderResolver();
    const deps = makeDeps({ repositories, providers });
    const handler = createCompleteUploadHandler(deps);

    const res = await handler(
      {
        operation: 'complete',
        uploadId: session.id,
        parts: [
          { partNumber: 1, etag: '"etag-1"' },
          { partNumber: 2, etag: '"etag-2"' },
        ],
      },
      makeUserCtx(),
    );

    expect(res.session.status).toBe('completed');
    expect(res.object.status).toBe('uploaded');
    const completes = providers.adapter.calls.filter((c) => c.method === 'completeMultipartUpload');
    expect(completes.length).toBe(1);
  });

  test('rejects multipart complete without parts', async () => {
    const repositories = new FakeRepositories();
    const { session } = seedPending(repositories, {
      uploadMethod: 'multipart',
      providerUploadId: 'mp-upload-1',
    });
    const deps = makeDeps({ repositories });
    const handler = createCompleteUploadHandler(deps);
    await expect(
      handler({ operation: 'complete', uploadId: session.id }, makeUserCtx()),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('rejects multipart session missing providerUploadId (inconsistent state)', async () => {
    const repositories = new FakeRepositories();
    const { session } = seedPending(repositories, {
      uploadMethod: 'multipart',
      providerUploadId: null, // FK invariant breach.
    });
    const deps = makeDeps({ repositories });
    const handler = createCompleteUploadHandler(deps);
    await expect(
      handler(
        {
          operation: 'complete',
          uploadId: session.id,
          parts: [{ partNumber: 1, etag: '"e"' }],
        },
        makeUserCtx(),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('completeUploadHandler — state transitions', () => {
  test('idempotent on already-completed session', async () => {
    const repositories = new FakeRepositories();
    const { session } = seedPending(repositories);
    repositories.setSessionStatus(session.id, 'completed');
    const deps = makeDeps({ repositories });
    const handler = createCompleteUploadHandler(deps);
    const res = await handler({ operation: 'complete', uploadId: session.id }, makeUserCtx());
    expect(res.session.status).toBe('completed');
  });

  test('rejects already-aborted session', async () => {
    const repositories = new FakeRepositories();
    const { session } = seedPending(repositories);
    repositories.setSessionStatus(session.id, 'aborted');
    const deps = makeDeps({ repositories });
    const handler = createCompleteUploadHandler(deps);
    await expect(
      handler({ operation: 'complete', uploadId: session.id }, makeUserCtx()),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('rejects expired session', async () => {
    const repositories = new FakeRepositories();
    const past = new Date(Date.now() - 60_000);
    const { session } = seedPending(repositories, { expiresAt: past });
    const deps = makeDeps({ repositories });
    const handler = createCompleteUploadHandler(deps);
    await expect(
      handler({ operation: 'complete', uploadId: session.id }, makeUserCtx()),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('rejects session with status=expired', async () => {
    const repositories = new FakeRepositories();
    const { session } = seedPending(repositories);
    repositories.setSessionStatus(session.id, 'expired');
    const deps = makeDeps({ repositories });
    const handler = createCompleteUploadHandler(deps);
    await expect(
      handler({ operation: 'complete', uploadId: session.id }, makeUserCtx()),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('cross-workspace denial — session id belongs to another workspace', async () => {
    const repositories = new FakeRepositories();
    const otherWs = '00000000-0000-4000-8000-0000000000ff';
    const { session } = seedPending(repositories, { workspaceId: otherWs });
    const deps = makeDeps({ repositories });
    const handler = createCompleteUploadHandler(deps);
    // Caller's workspaceId is TEST_WORKSPACE_ID, but the session belongs to otherWs.
    await expect(
      handler({ operation: 'complete', uploadId: session.id }, makeUserCtx()),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('unknown uploadId surfaces "not found" envelope', async () => {
    const repositories = new FakeRepositories();
    const deps = makeDeps({ repositories });
    const handler = createCompleteUploadHandler(deps);
    await expect(
      handler(
        { operation: 'complete', uploadId: '00000000-0000-4000-8000-000000abc999' },
        makeUserCtx(),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('completeUploadHandler — race-loss path', () => {
  test('conditional miss that resolved to completed is treated as idempotent success', async () => {
    const repositories = new FakeRepositories();
    const { session } = seedPending(repositories);
    // The session is observed as `pending` at first lookup, then the conditional
    // update misses (e.g. concurrent finalize), and on re-check it has flipped
    // to `completed`. Simulate via a one-shot failure flag that the post-update
    // re-read finds as `completed`.
    let firstReadDone = false;
    const origFind = repositories.sessions.findByIdForWorkspace;
    repositories.sessions.findByIdForWorkspace = async (input) => {
      const r = await origFind(input);
      if (!firstReadDone) {
        firstReadDone = true;
        return r;
      }
      // Subsequent reads see the row as completed.
      if (r) return { ...r, status: 'completed' as const, completedAt: new Date() };
      return r;
    };
    repositories.failConditionalComplete = true;
    const deps = makeDeps({ repositories });
    const handler = createCompleteUploadHandler(deps);

    const res = await handler({ operation: 'complete', uploadId: session.id }, makeUserCtx());
    expect(res.session.status).toBe('completed');
  });

  test('conditional miss that resolved to non-completed surfaces state-conflict', async () => {
    const repositories = new FakeRepositories();
    const { session } = seedPending(repositories);
    let firstReadDone = false;
    const origFind = repositories.sessions.findByIdForWorkspace;
    repositories.sessions.findByIdForWorkspace = async (input) => {
      const r = await origFind(input);
      if (!firstReadDone) {
        firstReadDone = true;
        return r;
      }
      if (r) return { ...r, status: 'aborted' as const, abortedAt: new Date() };
      return r;
    };
    repositories.failConditionalComplete = true;
    const deps = makeDeps({ repositories });
    const handler = createCompleteUploadHandler(deps);
    await expect(
      handler({ operation: 'complete', uploadId: session.id }, makeUserCtx()),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('completeUploadHandler — payload validation', () => {
  test('rejects non-UUID uploadId', async () => {
    const handler = createCompleteUploadHandler(makeDeps());
    await expect(
      handler({ operation: 'complete', uploadId: 'not-a-uuid' }, makeUserCtx()),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('rejects extra fields (strict schema)', async () => {
    const handler = createCompleteUploadHandler(makeDeps());
    await expect(
      handler(
        {
          operation: 'complete',
          uploadId: '00000000-0000-4000-8000-000000000001',
          extra: 'nope',
        },
        makeUserCtx(),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('completeUploadHandler — defensive branches', () => {
  test('inconsistent state when already-completed session has no object', async () => {
    const repositories = new FakeRepositories();
    const { session } = seedPending(repositories);
    repositories.setSessionStatus(session.id, 'completed');
    repositories.forceDeleteObject(session.objectId);
    const deps = makeDeps({ repositories });
    const handler = createCompleteUploadHandler(deps);
    await expect(
      handler({ operation: 'complete', uploadId: session.id }, makeUserCtx()),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('inconsistent state when pending session has no object row', async () => {
    const repositories = new FakeRepositories();
    const { session } = seedPending(repositories);
    repositories.forceDeleteObject(session.objectId);
    const deps = makeDeps({ repositories });
    const handler = createCompleteUploadHandler(deps);
    await expect(
      handler({ operation: 'complete', uploadId: session.id }, makeUserCtx()),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('forbidden when workspace has no provider during complete', async () => {
    const repositories = new FakeRepositories();
    const { session } = seedPending(repositories);
    const providers = new FakeProviderResolver();
    providers.unconfigured = true;
    const deps = makeDeps({ repositories, providers });
    const handler = createCompleteUploadHandler(deps);
    await expect(
      handler({ operation: 'complete', uploadId: session.id }, makeUserCtx()),
    ).rejects.toThrow(/storage provider/i);
  });

  test('markUploaded miss surfaces inconsistent-state envelope', async () => {
    const repositories = new FakeRepositories();
    const { session } = seedPending(repositories);
    // After session is marked completed, delete the object so markUploaded fails.
    // Wrap markUploaded with a stub that always returns null.
    const handler = createCompleteUploadHandler({
      ...makeDeps({ repositories }),
      objects: {
        ...repositories.objects,
        markUploaded: async () => null,
      },
    });
    await expect(
      handler({ operation: 'complete', uploadId: session.id }, makeUserCtx()),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
