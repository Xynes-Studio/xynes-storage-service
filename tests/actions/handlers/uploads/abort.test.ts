/**
 * STORAGE-5 — `abort` upload session handler tests.
 *
 * Covers:
 *   - Happy-path single + multipart abort.
 *   - Provider `abortMultipartUpload` is called for multipart sessions only.
 *   - Idempotency on already-aborted / expired sessions.
 *   - Rejects abort of already-completed sessions.
 *   - Cross-workspace denial.
 *   - Provider `NoSuchUpload` is swallowed and the local row still flips.
 *   - Non-ProviderAdapterError from the provider IS re-thrown.
 *   - Race-loss path.
 *   - Response shape redaction.
 */
import { describe, expect, test } from 'bun:test';
import { createAbortUploadHandler } from '../../../../src/actions/handlers/uploads/abort';
import { ValidationError } from '../../../../src/actions/errors';
import { ProviderAdapterError } from '../../../../src/infra/providers/errors';
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
    workspaceId: string;
  }> = {},
): UploadSessionRecord {
  const workspaceId = overrides.workspaceId ?? TEST_WORKSPACE_ID;
  const objectId = '00000000-0000-4000-8000-000000aa0002';
  const sessionId = '00000000-0000-4000-8000-000000bb0002';
  const now = new Date();
  const session: UploadSessionRecord = {
    id: sessionId,
    workspaceId,
    objectId,
    uploadMethod: overrides.uploadMethod ?? 'single',
    providerUploadId: overrides.providerUploadId ?? null,
    status: 'pending',
    createdAt: now,
    expiresAt: new Date(now.getTime() + 60_000),
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
  return session;
}

describe('abortUploadHandler — happy paths', () => {
  test('marks single-upload session aborted (no provider call)', async () => {
    const repositories = new FakeRepositories();
    const session = seedPending(repositories);
    const providers = new FakeProviderResolver();
    const deps = makeDeps({ repositories, providers });
    const handler = createAbortUploadHandler(deps);
    const res = await handler({ operation: 'abort', uploadId: session.id }, makeUserCtx());
    expect(res.session.status).toBe('aborted');
    expect(res.session.abortedAt).not.toBeNull();
    const aborts = providers.adapter.calls.filter((c) => c.method === 'abortMultipartUpload');
    expect(aborts.length).toBe(0);
  });

  test('calls provider abortMultipartUpload for multipart sessions', async () => {
    const repositories = new FakeRepositories();
    const session = seedPending(repositories, {
      uploadMethod: 'multipart',
      providerUploadId: 'mp-upload-2',
    });
    const providers = new FakeProviderResolver();
    const deps = makeDeps({ repositories, providers });
    const handler = createAbortUploadHandler(deps);

    await handler({ operation: 'abort', uploadId: session.id }, makeUserCtx());

    const aborts = providers.adapter.calls.filter((c) => c.method === 'abortMultipartUpload');
    expect(aborts.length).toBe(1);
  });
});

describe('abortUploadHandler — state transitions', () => {
  test('idempotent on already-aborted session', async () => {
    const repositories = new FakeRepositories();
    const session = seedPending(repositories);
    repositories.setSessionStatus(session.id, 'aborted');
    const providers = new FakeProviderResolver();
    const deps = makeDeps({ repositories, providers });
    const handler = createAbortUploadHandler(deps);
    const res = await handler({ operation: 'abort', uploadId: session.id }, makeUserCtx());
    expect(res.session.status).toBe('aborted');
    // Provider must NOT be re-touched on idempotent abort.
    expect(providers.adapter.calls.length).toBe(0);
  });

  test('idempotent on expired session', async () => {
    const repositories = new FakeRepositories();
    const session = seedPending(repositories);
    repositories.setSessionStatus(session.id, 'expired');
    const deps = makeDeps({ repositories });
    const handler = createAbortUploadHandler(deps);
    const res = await handler({ operation: 'abort', uploadId: session.id }, makeUserCtx());
    expect(res.session.status).toBe('expired');
  });

  test('rejects abort of already-completed session', async () => {
    const repositories = new FakeRepositories();
    const session = seedPending(repositories);
    repositories.setSessionStatus(session.id, 'completed');
    const deps = makeDeps({ repositories });
    const handler = createAbortUploadHandler(deps);
    await expect(
      handler({ operation: 'abort', uploadId: session.id }, makeUserCtx()),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('cross-workspace denial — session belongs to another workspace', async () => {
    const repositories = new FakeRepositories();
    const otherWs = '00000000-0000-4000-8000-0000000000fe';
    const session = seedPending(repositories, { workspaceId: otherWs });
    const deps = makeDeps({ repositories });
    const handler = createAbortUploadHandler(deps);
    await expect(
      handler({ operation: 'abort', uploadId: session.id }, makeUserCtx()),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('unknown uploadId surfaces "not found" envelope', async () => {
    const repositories = new FakeRepositories();
    const deps = makeDeps({ repositories });
    const handler = createAbortUploadHandler(deps);
    await expect(
      handler(
        { operation: 'abort', uploadId: '00000000-0000-4000-8000-000000000fff' },
        makeUserCtx(),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('abortUploadHandler — provider error handling', () => {
  test('swallows ProviderAdapterError from abortMultipartUpload (NoSuchUpload path)', async () => {
    const repositories = new FakeRepositories();
    const session = seedPending(repositories, {
      uploadMethod: 'multipart',
      providerUploadId: 'mp-upload-3',
    });
    const providers = new FakeProviderResolver();
    providers.adapter.abortMultipartUploadImpl = async () => {
      throw new ProviderAdapterError('PROVIDER_OPERATION_FAILED', 'No such upload');
    };
    const deps = makeDeps({ repositories, providers });
    const handler = createAbortUploadHandler(deps);
    const res = await handler({ operation: 'abort', uploadId: session.id }, makeUserCtx());
    expect(res.session.status).toBe('aborted');
  });

  test('re-throws non-ProviderAdapterError from the provider', async () => {
    const repositories = new FakeRepositories();
    const session = seedPending(repositories, {
      uploadMethod: 'multipart',
      providerUploadId: 'mp-upload-4',
    });
    const providers = new FakeProviderResolver();
    providers.adapter.abortMultipartUploadImpl = async () => {
      throw new Error('unexpected network failure');
    };
    const deps = makeDeps({ repositories, providers });
    const handler = createAbortUploadHandler(deps);
    await expect(
      handler({ operation: 'abort', uploadId: session.id }, makeUserCtx()),
    ).rejects.toThrow('unexpected network failure');
  });
});

describe('abortUploadHandler — race-loss path', () => {
  test('conditional miss resolved to aborted is treated as idempotent success', async () => {
    const repositories = new FakeRepositories();
    const session = seedPending(repositories);
    repositories.failConditionalAbort = true; // Force the conditional UPDATE to miss.
    repositories.setSessionStatus(session.id, 'aborted');
    const deps = makeDeps({ repositories });
    const handler = createAbortUploadHandler(deps);
    const res = await handler({ operation: 'abort', uploadId: session.id }, makeUserCtx());
    expect(res.session.status).toBe('aborted');
  });

  test('conditional miss resolved to completed surfaces "already completed"', async () => {
    const repositories = new FakeRepositories();
    const session = seedPending(repositories);
    repositories.failConditionalAbort = true;
    repositories.setSessionStatus(session.id, 'completed');
    const deps = makeDeps({ repositories });
    const handler = createAbortUploadHandler(deps);
    await expect(
      handler({ operation: 'abort', uploadId: session.id }, makeUserCtx()),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('abortUploadHandler — payload validation', () => {
  test('rejects non-UUID uploadId', async () => {
    const handler = createAbortUploadHandler(makeDeps());
    await expect(
      handler({ operation: 'abort', uploadId: 'bad' }, makeUserCtx()),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('rejects extra fields (strict schema)', async () => {
    const handler = createAbortUploadHandler(makeDeps());
    await expect(
      handler(
        {
          operation: 'abort',
          uploadId: '00000000-0000-4000-8000-000000000001',
          extra: 'nope',
        },
        makeUserCtx(),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('abortUploadHandler — defensive branches', () => {
  test('skips provider abort when associated object row is missing', async () => {
    const repositories = new FakeRepositories();
    const session = seedPending(repositories, {
      uploadMethod: 'multipart',
      providerUploadId: 'mp-upload-orphan',
    });
    repositories.forceDeleteObject(session.objectId);
    const providers = new FakeProviderResolver();
    const deps = makeDeps({ repositories, providers });
    const handler = createAbortUploadHandler(deps);
    const res = await handler({ operation: 'abort', uploadId: session.id }, makeUserCtx());
    // Local row still flips to `aborted`.
    expect(res.session.status).toBe('aborted');
    // Provider call MUST NOT happen because we couldn't find the object.
    const aborts = providers.adapter.calls.filter((c) => c.method === 'abortMultipartUpload');
    expect(aborts.length).toBe(0);
  });

  test('skips provider abort when workspace has no provider configured', async () => {
    const repositories = new FakeRepositories();
    const session = seedPending(repositories, {
      uploadMethod: 'multipart',
      providerUploadId: 'mp-upload-orphan2',
    });
    const providers = new FakeProviderResolver();
    providers.unconfigured = true;
    const deps = makeDeps({ repositories, providers });
    const handler = createAbortUploadHandler(deps);
    const res = await handler({ operation: 'abort', uploadId: session.id }, makeUserCtx());
    expect(res.session.status).toBe('aborted');
  });

  test('conditional miss resolved to still-pending surfaces "no longer pending"', async () => {
    const repositories = new FakeRepositories();
    const session = seedPending(repositories);
    repositories.failConditionalAbort = true;
    // Session stays `pending` per the find query, so neither the
    // aborted/expired nor the completed branch matches.
    const deps = makeDeps({ repositories });
    const handler = createAbortUploadHandler(deps);
    await expect(
      handler({ operation: 'abort', uploadId: session.id }, makeUserCtx()),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
