/**
 * DEDUP-2 — sanity tests for `FakeReferencesRepository` itself.
 *
 * The fake's behaviour matters because both `create-dedup.test.ts` and
 * `delete-references.test.ts` rely on it. A bug here would silently
 * change the meaning of those tests. This file documents the contract.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { FakeReferencesRepository, TEST_WORKSPACE_ID } from './_fakes';

const OBJECT_ID_A = '00000000-0000-4000-8000-00000000aaaa';
const OBJECT_ID_B = '00000000-0000-4000-8000-00000000bbbb';

describe('FakeReferencesRepository', () => {
  let repo: FakeReferencesRepository;
  beforeEach(() => {
    repo = new FakeReferencesRepository();
  });

  test('addReference inserts a fresh row -> inserted: true', async () => {
    const res = await repo.addReference({
      objectId: OBJECT_ID_A,
      workspaceId: TEST_WORKSPACE_ID,
      ownerKind: 'cms_entry',
      ownerId: '00000000-0000-4000-8000-00000000ccc1',
    });
    expect(res.inserted).toBe(true);
  });

  test('addReference is idempotent on duplicate composite key', async () => {
    const args = {
      objectId: OBJECT_ID_A,
      workspaceId: TEST_WORKSPACE_ID,
      ownerKind: 'cms_entry' as const,
      ownerId: '00000000-0000-4000-8000-00000000ccc2',
    };
    const first = await repo.addReference(args);
    const second = await repo.addReference(args);
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(repo.list()).toHaveLength(1);
  });

  test('addReference allows DIFFERENT ownerId on the SAME object', async () => {
    const base = {
      objectId: OBJECT_ID_A,
      workspaceId: TEST_WORKSPACE_ID,
      ownerKind: 'cms_entry' as const,
    };
    await repo.addReference({ ...base, ownerId: '00000000-0000-4000-8000-00000000ccc3' });
    await repo.addReference({ ...base, ownerId: '00000000-0000-4000-8000-00000000ccc4' });
    expect(repo.list()).toHaveLength(2);
  });

  test('parentWorkspaceLookup gate refuses inserts -> inserted: false', async () => {
    repo.parentWorkspaceLookup = () => false;
    const res = await repo.addReference({
      objectId: OBJECT_ID_A,
      workspaceId: TEST_WORKSPACE_ID,
      ownerKind: 'cms_entry',
      ownerId: '00000000-0000-4000-8000-00000000ccc5',
    });
    expect(res.inserted).toBe(false);
    expect(repo.list()).toHaveLength(0);
  });

  test('removeReference deletes a specific row and reports remaining', async () => {
    await repo.addReference({
      objectId: OBJECT_ID_A,
      workspaceId: TEST_WORKSPACE_ID,
      ownerKind: 'cms_entry',
      ownerId: '00000000-0000-4000-8000-00000000ccc6',
    });
    await repo.addReference({
      objectId: OBJECT_ID_A,
      workspaceId: TEST_WORKSPACE_ID,
      ownerKind: 'cms_entry',
      ownerId: '00000000-0000-4000-8000-00000000ccc7',
    });
    const res = await repo.removeReference({
      objectId: OBJECT_ID_A,
      workspaceId: TEST_WORKSPACE_ID,
      ownerKind: 'cms_entry',
      ownerId: '00000000-0000-4000-8000-00000000ccc6',
    });
    expect(res.remaining).toBe(1);
    expect(repo.list()).toHaveLength(1);
  });

  test('removeReference is idempotent on missing row', async () => {
    const res = await repo.removeReference({
      objectId: OBJECT_ID_A,
      workspaceId: TEST_WORKSPACE_ID,
      ownerKind: 'cms_entry',
      ownerId: '00000000-0000-4000-8000-00000000ccc8',
    });
    expect(res.remaining).toBe(0);
  });

  test('parentWorkspaceLookup gate forces removeReference to return remaining=0', async () => {
    await repo.addReference({
      objectId: OBJECT_ID_A,
      workspaceId: TEST_WORKSPACE_ID,
      ownerKind: 'cms_entry',
      ownerId: '00000000-0000-4000-8000-00000000ccc9',
    });
    repo.parentWorkspaceLookup = () => false;
    const res = await repo.removeReference({
      objectId: OBJECT_ID_A,
      workspaceId: TEST_WORKSPACE_ID,
      ownerKind: 'cms_entry',
      ownerId: '00000000-0000-4000-8000-00000000ccc9',
    });
    expect(res.remaining).toBe(0);
    // The row was NOT deleted -- the gate refused before any mutation.
    expect(repo.list()).toHaveLength(1);
  });

  test('countReferences walks only the target object id', async () => {
    await repo.addReference({
      objectId: OBJECT_ID_A,
      workspaceId: TEST_WORKSPACE_ID,
      ownerKind: 'cms_entry',
      ownerId: '00000000-0000-4000-8000-00000000ccca',
    });
    await repo.addReference({
      objectId: OBJECT_ID_A,
      workspaceId: TEST_WORKSPACE_ID,
      ownerKind: 'comment',
      ownerId: '00000000-0000-4000-8000-00000000cccb',
    });
    await repo.addReference({
      objectId: OBJECT_ID_B,
      workspaceId: TEST_WORKSPACE_ID,
      ownerKind: 'cms_entry',
      ownerId: '00000000-0000-4000-8000-00000000cccc',
    });
    expect(
      await repo.countReferences({ objectId: OBJECT_ID_A, workspaceId: TEST_WORKSPACE_ID }),
    ).toBe(2);
    expect(
      await repo.countReferences({ objectId: OBJECT_ID_B, workspaceId: TEST_WORKSPACE_ID }),
    ).toBe(1);
  });

  test('throwOnAddOnce surfaces an exception then resets', async () => {
    repo.throwOnAddOnce = new Error('transient FK glitch');
    await expect(
      repo.addReference({
        objectId: OBJECT_ID_A,
        workspaceId: TEST_WORKSPACE_ID,
        ownerKind: 'cms_entry',
        ownerId: '00000000-0000-4000-8000-00000000cccd',
      }),
    ).rejects.toThrow('transient FK glitch');
    // Reset after one throw -> next call succeeds.
    const res = await repo.addReference({
      objectId: OBJECT_ID_A,
      workspaceId: TEST_WORKSPACE_ID,
      ownerKind: 'cms_entry',
      ownerId: '00000000-0000-4000-8000-00000000cccd',
    });
    expect(res.inserted).toBe(true);
  });

  test('seed() bypasses the parent-workspace gate', async () => {
    repo.parentWorkspaceLookup = () => false;
    repo.seed({
      objectId: OBJECT_ID_A,
      ownerKind: 'cms_entry',
      ownerId: '00000000-0000-4000-8000-00000000ccce',
    });
    expect(repo.list()).toHaveLength(1);
  });

  test('calls log captures every method invocation', async () => {
    await repo.addReference({
      objectId: OBJECT_ID_A,
      workspaceId: TEST_WORKSPACE_ID,
      ownerKind: 'cms_entry',
      ownerId: '00000000-0000-4000-8000-00000000cccf',
    });
    await repo.removeReference({
      objectId: OBJECT_ID_A,
      workspaceId: TEST_WORKSPACE_ID,
      ownerKind: 'cms_entry',
      ownerId: '00000000-0000-4000-8000-00000000cccf',
    });
    await repo.countReferences({ objectId: OBJECT_ID_A, workspaceId: TEST_WORKSPACE_ID });
    expect(repo.calls.map((c) => c.method)).toEqual([
      'addReference',
      'removeReference',
      'countReferences',
    ]);
  });
});
