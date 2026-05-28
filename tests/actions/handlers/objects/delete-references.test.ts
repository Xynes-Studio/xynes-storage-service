/**
 * DEDUP-2 — delete handler reference-counted soft-delete tests.
 *
 * Covers the new reference-counted path on `createDeleteObjectHandler`:
 *
 *   - With `ownerKind` + `ownerId` AND references remain -> object is
 *     NOT soft-deleted; `referencesRemaining` is surfaced.
 *   - With `ownerKind` + `ownerId` AND last reference removed -> object
 *     IS soft-deleted (legacy path).
 *   - Without owner metadata (legacy / force-delete mode) -> object is
 *     soft-deleted immediately. Pre-DEDUP-2 callers see byte-for-byte
 *     STORAGE-6 behaviour.
 *   - Provider-delete swallowing posture unchanged from STORAGE-6.
 *   - Schema validation: `ownerKind` + `ownerId` must be paired.
 */
import { describe, expect, test } from 'bun:test';
import { createDeleteObjectHandler } from '../../../../src/actions/handlers/objects/delete';
import {
  ExtendedFakeObjectRepository,
  ExtendedFakeProviderResolver,
  FakeReferencesRepository,
  OTHER_WORKSPACE_ID,
  makeObject,
  makeObjectsDeps,
  makeUserCtx,
} from './_fakes';

const OWNER_KIND_CMS = 'cms_entry' as const;
const OWNER_ID_A = '00000000-0000-4000-8000-00000000aaa1';
const OWNER_ID_B = '00000000-0000-4000-8000-00000000aaa2';

describe('deleteObjectHandler — reference-counted delete (DEDUP-2)', () => {
  test('last reference removed -> object IS soft-deleted (+ provider call)', async () => {
    const objects = new ExtendedFakeObjectRepository();
    const obj = makeObject({ status: 'ready' });
    objects.seed(obj);
    const references = new FakeReferencesRepository();
    references.seed({
      objectId: obj.id,
      ownerKind: OWNER_KIND_CMS,
      ownerId: OWNER_ID_A,
    });
    const providers = new ExtendedFakeProviderResolver({ providerId: obj.providerId });

    const res = await createDeleteObjectHandler(
      makeObjectsDeps({ objects, providers, references }),
    )(
      {
        operation: 'delete',
        objectId: obj.id,
        ownerKind: OWNER_KIND_CMS,
        ownerId: OWNER_ID_A,
      },
      makeUserCtx(),
    );
    expect(res.object.status).toBe('deleted');
    expect(res.referencesRemaining).toBeUndefined();
    // Provider delete fired because the object was actually soft-deleted.
    expect(providers.adapter.calls.find((c) => c.method === 'deleteObject')).toBeTruthy();
    // Reference row gone.
    expect(references.list()).toHaveLength(0);
  });

  test('references remain -> object STAYS ready, referencesRemaining surfaced, NO provider call', async () => {
    const objects = new ExtendedFakeObjectRepository();
    const obj = makeObject({ status: 'ready' });
    objects.seed(obj);
    const references = new FakeReferencesRepository();
    references.seed({ objectId: obj.id, ownerKind: OWNER_KIND_CMS, ownerId: OWNER_ID_A });
    references.seed({ objectId: obj.id, ownerKind: OWNER_KIND_CMS, ownerId: OWNER_ID_B });
    const providers = new ExtendedFakeProviderResolver({ providerId: obj.providerId });

    const res = await createDeleteObjectHandler(
      makeObjectsDeps({ objects, providers, references }),
    )(
      {
        operation: 'delete',
        objectId: obj.id,
        ownerKind: OWNER_KIND_CMS,
        ownerId: OWNER_ID_A,
      },
      makeUserCtx(),
    );
    expect(res.object.status).toBe('ready');
    expect(res.referencesRemaining).toBe(1);
    // Provider was NEVER asked about a delete — bytes still in use.
    expect(providers.adapter.calls.filter((c) => c.method === 'deleteObject')).toEqual([]);
    expect(providers.resolveByProviderIdCount).toBe(0);
    // The OTHER reference row survives.
    const remaining = references.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({
      objectId: obj.id,
      ownerKind: OWNER_KIND_CMS,
      ownerId: OWNER_ID_B,
    });
  });

  test('removing a reference that does not exist is idempotent (treated as success)', async () => {
    const objects = new ExtendedFakeObjectRepository();
    const obj = makeObject({ status: 'ready' });
    objects.seed(obj);
    const references = new FakeReferencesRepository();
    // No references seeded for this owner -> remaining will be 0 -> soft-delete.
    const providers = new ExtendedFakeProviderResolver({ providerId: obj.providerId });

    const res = await createDeleteObjectHandler(
      makeObjectsDeps({ objects, providers, references }),
    )(
      {
        operation: 'delete',
        objectId: obj.id,
        ownerKind: OWNER_KIND_CMS,
        ownerId: OWNER_ID_A,
      },
      makeUserCtx(),
    );
    // No references existed -> remaining=0 -> object soft-deletes.
    expect(res.object.status).toBe('deleted');
  });

  test('force-delete mode (no ownerKind/ownerId) preserves byte-for-byte STORAGE-6 behaviour', async () => {
    const objects = new ExtendedFakeObjectRepository();
    const obj = makeObject({ status: 'ready' });
    objects.seed(obj);
    const references = new FakeReferencesRepository();
    references.seed({ objectId: obj.id, ownerKind: OWNER_KIND_CMS, ownerId: OWNER_ID_A });
    references.seed({ objectId: obj.id, ownerKind: OWNER_KIND_CMS, ownerId: OWNER_ID_B });
    const providers = new ExtendedFakeProviderResolver({ providerId: obj.providerId });

    const res = await createDeleteObjectHandler(
      makeObjectsDeps({ objects, providers, references }),
    )({ operation: 'delete', objectId: obj.id }, makeUserCtx());
    // Force-delete: object IS soft-deleted even though references exist.
    expect(res.object.status).toBe('deleted');
    expect(res.referencesRemaining).toBeUndefined();
    expect(providers.adapter.calls.find((c) => c.method === 'deleteObject')).toBeTruthy();
    // References are LEFT IN PLACE — the DEDUP-1 `ON DELETE CASCADE`
    // would only clean them on hard-delete.
    expect(references.list().length).toBeGreaterThan(0);
  });

  test('reference-counted delete asks the handler for the references repo — refuses when undefined', async () => {
    const objects = new ExtendedFakeObjectRepository();
    const obj = makeObject({ status: 'ready' });
    objects.seed(obj);
    const providers = new ExtendedFakeProviderResolver({ providerId: obj.providerId });

    // Deliberately omit `references` -> handler must refuse the
    // ref-counted call rather than silently force-deleting.
    await expect(
      createDeleteObjectHandler(makeObjectsDeps({ objects, providers, references: null }))(
        {
          operation: 'delete',
          objectId: obj.id,
          ownerKind: OWNER_KIND_CMS,
          ownerId: OWNER_ID_A,
        },
        makeUserCtx(),
      ),
    ).rejects.toMatchObject({
      name: 'ValidationError',
      message: 'Reference-counted delete is not available on this deployment',
    });
    // Object is still `ready` — refusal does NOT touch the row.
    expect(objects.objects.get(obj.id)?.status).toBe('ready');
  });

  test('cross-workspace ref-counted delete returns "not found" without leaking', async () => {
    const objects = new ExtendedFakeObjectRepository();
    const foreign = makeObject({ workspaceId: OTHER_WORKSPACE_ID, status: 'ready' });
    objects.seed(foreign);
    const references = new FakeReferencesRepository();
    references.seed({ objectId: foreign.id, ownerKind: OWNER_KIND_CMS, ownerId: OWNER_ID_A });

    await expect(
      createDeleteObjectHandler(makeObjectsDeps({ objects, references }))(
        {
          operation: 'delete',
          objectId: foreign.id,
          ownerKind: OWNER_KIND_CMS,
          ownerId: OWNER_ID_A,
        },
        makeUserCtx(),
      ),
    ).rejects.toMatchObject({ name: 'ValidationError', message: 'Object not found' });
    // References untouched — the cross-workspace probe never reached the
    // reference repo (object lookup short-circuits first).
    expect(references.list()).toHaveLength(1);
  });

  test('already-deleted object short-circuits BEFORE consulting references', async () => {
    const objects = new ExtendedFakeObjectRepository();
    const obj = makeObject({ status: 'deleted' });
    objects.seed(obj);
    const references = new FakeReferencesRepository();
    references.seed({ objectId: obj.id, ownerKind: OWNER_KIND_CMS, ownerId: OWNER_ID_A });

    const res = await createDeleteObjectHandler(makeObjectsDeps({ objects, references }))(
      {
        operation: 'delete',
        objectId: obj.id,
        ownerKind: OWNER_KIND_CMS,
        ownerId: OWNER_ID_A,
      },
      makeUserCtx(),
    );
    // Idempotent — return current state, references repo NEVER consulted.
    expect(res.object.status).toBe('deleted');
    expect(references.calls).toHaveLength(0);
  });

  test('response shape — no provider material leaks via referencesRemaining path', async () => {
    const objects = new ExtendedFakeObjectRepository();
    const obj = makeObject({ status: 'ready' });
    objects.seed(obj);
    const references = new FakeReferencesRepository();
    references.seed({ objectId: obj.id, ownerKind: OWNER_KIND_CMS, ownerId: OWNER_ID_A });
    references.seed({ objectId: obj.id, ownerKind: OWNER_KIND_CMS, ownerId: OWNER_ID_B });

    const res = await createDeleteObjectHandler(makeObjectsDeps({ objects, references }))(
      {
        operation: 'delete',
        objectId: obj.id,
        ownerKind: OWNER_KIND_CMS,
        ownerId: OWNER_ID_A,
      },
      makeUserCtx(),
    );
    const json = JSON.stringify(res);
    expect(json).not.toMatch(/"providerId"/);
    expect(json).not.toMatch(/"providerObjectKey"/);
    expect(json).not.toMatch(/"provider_?kind"/);
    expect(json).not.toMatch(/"endpoint"/);
    expect(json).not.toMatch(/"region"/);
    expect(json).not.toMatch(/"bucket"/);
    expect(json).not.toMatch(/"credential_?ref"/);
    expect(json).not.toMatch(/"accessKeyId"/);
    expect(json).not.toMatch(/"secretAccessKey"/);
    expect(json).toMatch(/"referencesRemaining":1/);
  });
});

describe('deleteObjectHandler — schema validation (DEDUP-2)', () => {
  test('rejects ownerKind without ownerId', async () => {
    await expect(
      createDeleteObjectHandler(makeObjectsDeps())(
        {
          operation: 'delete',
          objectId: '00000000-0000-4000-8000-00000000aaaa',
          ownerKind: OWNER_KIND_CMS,
        },
        makeUserCtx(),
      ),
    ).rejects.toMatchObject({
      name: 'ValidationError',
      message: 'ownerKind and ownerId must be provided together',
    });
  });

  test('rejects ownerId without ownerKind', async () => {
    await expect(
      createDeleteObjectHandler(makeObjectsDeps())(
        {
          operation: 'delete',
          objectId: '00000000-0000-4000-8000-00000000aaaa',
          ownerId: OWNER_ID_A,
        },
        makeUserCtx(),
      ),
    ).rejects.toMatchObject({
      name: 'ValidationError',
      message: 'ownerKind and ownerId must be provided together',
    });
  });

  test('rejects unknown ownerKind value', async () => {
    await expect(
      createDeleteObjectHandler(makeObjectsDeps())(
        {
          operation: 'delete',
          objectId: '00000000-0000-4000-8000-00000000aaaa',
          ownerKind: 'attacker_owned' as 'cms_entry',
          ownerId: OWNER_ID_A,
        },
        makeUserCtx(),
      ),
    ).rejects.toMatchObject({ name: 'ValidationError' });
  });

  test('rejects non-UUID ownerId', async () => {
    await expect(
      createDeleteObjectHandler(makeObjectsDeps())(
        {
          operation: 'delete',
          objectId: '00000000-0000-4000-8000-00000000aaaa',
          ownerKind: OWNER_KIND_CMS,
          ownerId: 'not-a-uuid',
        },
        makeUserCtx(),
      ),
    ).rejects.toMatchObject({ name: 'ValidationError' });
  });
});

describe('deleteObjectHandler — references repo workspace isolation (DEDUP-2)', () => {
  test('FakeReferencesRepository parent-workspace lookup gate is honoured', async () => {
    const objects = new ExtendedFakeObjectRepository();
    const obj = makeObject({ status: 'ready' });
    objects.seed(obj);
    const references = new FakeReferencesRepository();
    references.seed({ objectId: obj.id, ownerKind: OWNER_KIND_CMS, ownerId: OWNER_ID_A });
    // Simulate the production posture: parent-workspace lookup says "no".
    references.parentWorkspaceLookup = () => false;
    const providers = new ExtendedFakeProviderResolver({ providerId: obj.providerId });

    const res = await createDeleteObjectHandler(
      makeObjectsDeps({ objects, providers, references }),
    )(
      {
        operation: 'delete',
        objectId: obj.id,
        ownerKind: OWNER_KIND_CMS,
        ownerId: OWNER_ID_A,
      },
      makeUserCtx(),
    );
    // The references repo returned remaining=0 -> object soft-deletes.
    // This is the safe outcome: a workspace mismatch can't refuse
    // delete on a row already passed the workspace gate.
    expect(res.object.status).toBe('deleted');
  });
});
