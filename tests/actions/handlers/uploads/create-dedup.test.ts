/**
 * DEDUP-2 — upload-create dedup short-circuit tests.
 *
 * Covers the new short-circuit path: when `sha256` is supplied AND the
 * service is wired with a `FakeReferencesRepository`, the handler probes
 * `findExistingByWorkspaceSha256`, attaches a reference row, and returns
 * the EXISTING object with `dedupHit: true`. The provider URL is NEVER
 * minted.
 *
 * Closes Bug 2 (handler-layer half) per
 * `xynes/xynes-infra/docs/plans/2026-05-27-storage-followups-combined.md` §9.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { createCreateUploadHandler } from '../../../../src/actions/handlers/uploads/create';
import {
  FakeReferencesRepository,
  FakeRepositories,
  makeApiKeyCtx,
  makeDeps,
  makeUserCtx,
  TEST_WORKSPACE_ID,
} from './_fakes';
import type { StorageObjectRecord } from '../../../../src/actions/handlers/uploads/types';

const SHA = 'a'.repeat(64); // 64 hex chars — passes the schema regex.
const OTHER_SHA = 'b'.repeat(64);

const BASE_PAYLOAD = {
  operation: 'create' as const,
  filename: 'photo.jpg',
  contentType: 'image/jpeg',
  byteSize: 1024,
  sha256: SHA,
};

const FIXED_PROVIDER_ID = '00000000-0000-4000-8000-0000000000a0';
const OTHER_WORKSPACE_ID = '00000000-0000-4000-8000-000000999111';

/**
 * Seed an existing object directly into the FakeRepositories. The handler's
 * dedup probe goes through `findExistingByWorkspaceSha256` which walks the
 * same in-memory map, so this is sufficient.
 */
function seedExisting(
  repos: FakeRepositories,
  overrides: Partial<StorageObjectRecord> = {},
): StorageObjectRecord {
  const obj: StorageObjectRecord = {
    id: '00000000-0000-4000-8000-000000000aaa',
    workspaceId: TEST_WORKSPACE_ID,
    providerId: FIXED_PROVIDER_ID,
    providerObjectKey: 'workspaces/ws/objects/aaa/photo.jpg',
    filename: 'photo.jpg',
    contentType: 'image/jpeg',
    byteSize: 1024,
    sha256: SHA,
    purpose: 'platform_generic',
    visibility: 'private',
    status: 'ready',
    compressionRequested: true,
    createdBy: null,
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z'),
    uploadedAt: new Date('2026-05-01T00:00:00.000Z'),
    ...overrides,
  };
  repos.seedSession(
    {
      id: 'placeholder-session',
      workspaceId: obj.workspaceId,
      objectId: obj.id,
      uploadMethod: 'single',
      providerUploadId: null,
      status: 'completed',
      createdAt: obj.createdAt,
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      completedAt: obj.uploadedAt,
      abortedAt: null,
      createdBy: null,
    },
    obj,
  );
  return obj;
}

describe('createUploadHandler — dedup short-circuit (DEDUP-2)', () => {
  let repositories: FakeRepositories;
  let references: FakeReferencesRepository;
  let deps: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    repositories = new FakeRepositories();
    references = new FakeReferencesRepository();
    deps = makeDeps({ repositories, references });
  });

  test('returns dedupHit: true when a ready row with matching sha256 exists', async () => {
    const existing = seedExisting(repositories);
    const handler = createCreateUploadHandler(deps);
    const res = await handler(BASE_PAYLOAD, makeUserCtx());
    expect(res.dedupHit).toBe(true);
    expect(res.objectId).toBe(existing.id);
    expect(res.uploadId).toBe(existing.id);
    expect(res.uploadUrl).toBeNull();
    expect(res.parts).toEqual([]);
    expect(res.uploadHeaders).toEqual({});
    expect(res.uploadMethod).toBe('single');
    // Provider URL was NEVER minted — adapter remained silent.
    expect(deps.providers.adapter.calls).toEqual([]);
    // Provider resolver was NEVER called either (the short-circuit fires
    // before resolveDefaultForWorkspace).
    expect(deps.providers.resolveCount).toBe(0);
  });

  test('dedup hit on a `processing` row also short-circuits', async () => {
    const existing = seedExisting(repositories, { status: 'processing' });
    const handler = createCreateUploadHandler(deps);
    const res = await handler(BASE_PAYLOAD, makeUserCtx());
    expect(res.dedupHit).toBe(true);
    expect(res.objectId).toBe(existing.id);
  });

  test('dedup hit on an `uploaded` row also short-circuits', async () => {
    const existing = seedExisting(repositories, { status: 'uploaded' });
    const handler = createCreateUploadHandler(deps);
    const res = await handler(BASE_PAYLOAD, makeUserCtx());
    expect(res.dedupHit).toBe(true);
    expect(res.objectId).toBe(existing.id);
  });

  test('pending_upload row is NOT a dedup hit (falls through to fresh upload)', async () => {
    seedExisting(repositories, { status: 'pending_upload' });
    const handler = createCreateUploadHandler(deps);
    const res = await handler(BASE_PAYLOAD, makeUserCtx());
    expect(res.dedupHit).toBe(false);
    // Adapter was called for the fresh upload.
    expect(deps.providers.adapter.calls.length).toBeGreaterThan(0);
  });

  test('failed row is NOT a dedup hit (falls through to fresh upload)', async () => {
    seedExisting(repositories, { status: 'failed' });
    const handler = createCreateUploadHandler(deps);
    const res = await handler(BASE_PAYLOAD, makeUserCtx());
    expect(res.dedupHit).toBe(false);
    expect(deps.providers.adapter.calls.length).toBeGreaterThan(0);
  });

  test('deleted row is NOT a dedup hit (falls through to fresh upload)', async () => {
    seedExisting(repositories, { status: 'deleted' });
    const handler = createCreateUploadHandler(deps);
    const res = await handler(BASE_PAYLOAD, makeUserCtx());
    expect(res.dedupHit).toBe(false);
    expect(deps.providers.adapter.calls.length).toBeGreaterThan(0);
  });

  test('missing sha256 always falls through to fresh upload', async () => {
    seedExisting(repositories);
    const handler = createCreateUploadHandler(deps);
    const res = await handler({ ...BASE_PAYLOAD, sha256: undefined }, makeUserCtx());
    expect(res.dedupHit).toBe(false);
    expect(deps.providers.adapter.calls.length).toBeGreaterThan(0);
  });

  test('non-matching sha256 falls through to fresh upload', async () => {
    seedExisting(repositories);
    const handler = createCreateUploadHandler(deps);
    const res = await handler({ ...BASE_PAYLOAD, sha256: OTHER_SHA }, makeUserCtx());
    expect(res.dedupHit).toBe(false);
    expect(deps.providers.adapter.calls.length).toBeGreaterThan(0);
  });

  test('cross-workspace isolation — same sha256 in OTHER workspace does NOT dedup', async () => {
    // Seed a "ready" row in a DIFFERENT workspace with the same content hash.
    seedExisting(repositories, { workspaceId: OTHER_WORKSPACE_ID });
    const handler = createCreateUploadHandler(deps);
    const res = await handler(BASE_PAYLOAD, makeUserCtx());
    expect(res.dedupHit).toBe(false);
    // Fresh upload was minted.
    expect(deps.providers.adapter.calls.length).toBeGreaterThan(0);
  });

  test('attaches reference row on dedup hit with defaulted ownerKind=platform_generic', async () => {
    const existing = seedExisting(repositories);
    const handler = createCreateUploadHandler(deps);
    await handler(BASE_PAYLOAD, makeUserCtx());
    const refs = references.list();
    expect(refs).toHaveLength(1);
    expect(refs[0].objectId).toBe(existing.id);
    expect(refs[0].ownerKind).toBe('platform_generic');
    // ownerId is the auto-generated UUID.
    expect(refs[0].ownerId).toBeTruthy();
  });

  test('attaches reference with caller-supplied ownerKind + ownerId', async () => {
    const existing = seedExisting(repositories);
    const ownerId = '00000000-0000-4000-8000-000000000bbb';
    const handler = createCreateUploadHandler(deps);
    await handler({ ...BASE_PAYLOAD, ownerKind: 'cms_entry', ownerId }, makeUserCtx());
    const refs = references.list();
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      objectId: existing.id,
      ownerKind: 'cms_entry',
      ownerId,
    });
  });

  test('dedup hit response shape — documented fields only', async () => {
    seedExisting(repositories);
    const handler = createCreateUploadHandler(deps);
    const res = await handler(BASE_PAYLOAD, makeUserCtx());
    const json = JSON.stringify(res);
    // No provider material leaks via the dedup-hit path.
    expect(json).not.toMatch(/"providerId"/);
    expect(json).not.toMatch(/"providerObjectKey"/);
    expect(json).not.toMatch(/"provider_?kind"/);
    expect(json).not.toMatch(/"endpoint"/);
    expect(json).not.toMatch(/"region"/);
    expect(json).not.toMatch(/"bucket"/);
    expect(json).not.toMatch(/"credential_?ref"/);
    expect(json).not.toMatch(/"accessKeyId"/);
    expect(json).not.toMatch(/"secretAccessKey"/);
    expect(json).not.toMatch(/"providerUploadId"/);
    // X-Amz-Signature would only appear if a presigned URL leaked through.
    expect(json).not.toMatch(/X-Amz-Signature/);
  });

  test('dedup hit returns the EXISTING uploader (not the current caller) — no identity leak', async () => {
    // Seed an object created by a DIFFERENT user.
    const otherUserId = '00000000-0000-4000-8000-00000000aaaa';
    seedExisting(repositories, { createdBy: otherUserId });
    const handler = createCreateUploadHandler(deps);
    const res = await handler(BASE_PAYLOAD, makeUserCtx());
    // The response is identical in shape to a fresh upload-create
    // response — only the `dedupHit` flag distinguishes them. The
    // `createdBy` value flows through normally (it's a STORAGE-6
    // documented field, not new identity exposure).
    expect(res.object.createdBy).toBe(otherUserId);
    // No additional fields leak.
    expect((res.object as unknown as Record<string, unknown>).providerId).toBeUndefined();
  });

  test('api_key actor — dedup hit still works, no createdBy mutation', async () => {
    const existing = seedExisting(repositories, { createdBy: null });
    const handler = createCreateUploadHandler(deps);
    const res = await handler(BASE_PAYLOAD, makeApiKeyCtx());
    expect(res.dedupHit).toBe(true);
    expect(res.object.id).toBe(existing.id);
    // createdBy stays NULL — dedup never re-stamps audit columns.
    expect(res.object.createdBy).toBeNull();
  });

  test('idempotent reference add: same caller dedups twice -> insert once, no error', async () => {
    seedExisting(repositories);
    const ownerId = '00000000-0000-4000-8000-000000000ccc';
    const handler = createCreateUploadHandler(deps);
    await handler({ ...BASE_PAYLOAD, ownerKind: 'cms_entry', ownerId }, makeUserCtx());
    await handler({ ...BASE_PAYLOAD, ownerKind: 'cms_entry', ownerId }, makeUserCtx());
    // Both calls succeeded; only one row in the join table.
    expect(references.list()).toHaveLength(1);
  });

  test('two different owners dedup the same bytes -> two reference rows', async () => {
    seedExisting(repositories);
    const handler = createCreateUploadHandler(deps);
    await handler(
      {
        ...BASE_PAYLOAD,
        ownerKind: 'cms_entry',
        ownerId: '00000000-0000-4000-8000-00000000dddd',
      },
      makeUserCtx(),
    );
    await handler(
      {
        ...BASE_PAYLOAD,
        ownerKind: 'cms_entry',
        ownerId: '00000000-0000-4000-8000-00000000eeee',
      },
      makeUserCtx(),
    );
    expect(references.list()).toHaveLength(2);
  });

  test('disabled references repo — dedup short-circuit is bypassed even when sha256 matches', async () => {
    // Mirror: when the service is not wired with a references repo, the
    // old STORAGE-5 path runs verbatim — fresh upload even on a content
    // collision. This is the backwards-compat envelope.
    seedExisting(repositories);
    const depsNoRefs = makeDeps({ repositories, references: null });
    const handler = createCreateUploadHandler(depsNoRefs);
    const res = await handler(BASE_PAYLOAD, makeUserCtx());
    expect(res.dedupHit).toBe(false);
    expect(depsNoRefs.providers.adapter.calls.length).toBeGreaterThan(0);
  });

  test('fresh-upload path with references repo wired -> reference row attached', async () => {
    // No seed -> no dedup hit -> fresh upload happens, then we expect
    // the post-create reference attach to fire.
    const handler = createCreateUploadHandler(deps);
    const res = await handler(BASE_PAYLOAD, makeUserCtx());
    expect(res.dedupHit).toBe(false);
    const refs = references.list();
    expect(refs).toHaveLength(1);
    expect(refs[0].objectId).toBe(res.objectId);
    expect(refs[0].ownerKind).toBe('platform_generic');
  });

  test('reference-add failure on fresh upload does NOT undo the upload', async () => {
    // The post-create attach is best-effort. A thrown addReference must
    // not roll back the persisted object/session.
    references.throwOnAddOnce = new Error('transient FK glitch');
    const handler = createCreateUploadHandler(deps);
    const res = await handler(BASE_PAYLOAD, makeUserCtx());
    expect(res.dedupHit).toBe(false);
    expect(res.uploadUrl).toBeTruthy();
    // No reference row was attached because the (best-effort) call threw.
    expect(references.list()).toHaveLength(0);
  });
});

describe('createUploadHandler — schema validation (DEDUP-2)', () => {
  test('rejects unknown ownerKind', async () => {
    const handler = createCreateUploadHandler(
      makeDeps({ references: new FakeReferencesRepository() }),
    );
    await expect(
      handler(
        {
          ...BASE_PAYLOAD,
          ownerKind: 'attacker_owned' as 'cms_entry',
          ownerId: '00000000-0000-4000-8000-00000000ffff',
        },
        makeUserCtx(),
      ),
    ).rejects.toMatchObject({ name: 'ValidationError' });
  });

  test('rejects non-UUID ownerId', async () => {
    const handler = createCreateUploadHandler(
      makeDeps({ references: new FakeReferencesRepository() }),
    );
    await expect(
      handler({ ...BASE_PAYLOAD, ownerKind: 'cms_entry', ownerId: 'not-a-uuid' }, makeUserCtx()),
    ).rejects.toMatchObject({ name: 'ValidationError' });
  });
});
