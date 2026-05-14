/**
 * STORAGE-6 — list handler tests.
 *
 * Covers:
 *   - Happy path with all filter combinations.
 *   - Pagination defaults + cursor pass-through (no `workspaceId` in cursor).
 *   - Cross-workspace isolation (repo never sees foreign rows).
 *   - Validation errors (unknown field, invalid status, malformed cursor).
 *   - Defensive: deleted rows that slip through are filtered out.
 *   - Response shape redaction (no provider_kind / endpoint / etc.).
 */
import { describe, expect, test } from 'bun:test';
import { createListObjectsHandler } from '../../../../src/actions/handlers/objects/list';
import { ValidationError } from '../../../../src/actions/errors';
import { encodeListCursor } from '../../../../src/actions/handlers/objects/cursor';
import {
  ExtendedFakeObjectRepository,
  OTHER_WORKSPACE_ID,
  TEST_WORKSPACE_ID,
  makeObject,
  makeObjectsDeps,
  makeUserCtx,
} from './_fakes';

const FORBIDDEN_FIELDS = [
  'provider_kind',
  'providerKind',
  'providerId',
  'providerObjectKey',
  'provider_object_key',
  'credential_ref',
  'credentialRef',
  'endpoint',
  'region',
  'bucket',
  'accessKeyId',
  'secretAccessKey',
];

function assertNoForbiddenFields(payload: unknown): void {
  const json = JSON.stringify(payload);
  for (const f of FORBIDDEN_FIELDS) {
    expect(json).not.toContain(`"${f}"`);
  }
}

describe('listObjectsHandler — happy paths', () => {
  test('returns workspace-scoped items with default limit', async () => {
    const objects = new ExtendedFakeObjectRepository();
    objects.seed(
      makeObject({ purpose: 'cms_media', status: 'ready' }),
      makeObject({ purpose: 'platform_generic', status: 'ready' }),
    );
    const deps = makeObjectsDeps({ objects });
    const res = await createListObjectsHandler(deps)({ operation: 'list' }, makeUserCtx());
    expect(res.items.length).toBe(2);
    expect(res.nextCursor).toBeNull();
  });

  test('forwards filters and limit to the repo', async () => {
    const objects = new ExtendedFakeObjectRepository();
    const createdByUser = '00000000-0000-4000-8000-000000000099';
    objects.seed(
      makeObject({
        purpose: 'cms_media',
        status: 'ready',
        createdBy: createdByUser,
      }),
      makeObject({ purpose: 'platform_generic', status: 'failed' }),
    );
    const deps = makeObjectsDeps({ objects });
    const res = await createListObjectsHandler(deps)(
      {
        operation: 'list',
        filters: {
          purpose: 'cms_media',
          status: 'ready',
          contentTypeFamily: 'image',
          createdBy: createdByUser,
          createdAfter: '2026-01-01T00:00:00.000Z',
          createdBefore: '2026-12-31T23:59:59.000Z',
        },
        limit: 10,
      },
      makeUserCtx(),
    );
    expect(objects.lastListInput?.workspaceId).toBe(TEST_WORKSPACE_ID);
    expect(objects.lastListInput?.filters.purpose).toBe('cms_media');
    expect(objects.lastListInput?.filters.status).toBe('ready');
    expect(objects.lastListInput?.filters.contentTypeFamily).toBe('image');
    expect(objects.lastListInput?.filters.createdAfter).toBeInstanceOf(Date);
    expect(objects.lastListInput?.filters.createdBefore).toBeInstanceOf(Date);
    expect(objects.lastListInput?.limit).toBe(10);
    expect(res.items.length).toBe(1);
  });

  test('defaults limit to DEFAULT_LIST_LIMIT', async () => {
    const objects = new ExtendedFakeObjectRepository();
    const deps = makeObjectsDeps({ objects });
    await createListObjectsHandler(deps)({ operation: 'list' }, makeUserCtx());
    expect(objects.lastListInput?.limit).toBe(50);
  });

  test('honours defaultListLimit dep override', async () => {
    const objects = new ExtendedFakeObjectRepository();
    const deps = makeObjectsDeps({ objects, defaultListLimit: 7 });
    await createListObjectsHandler(deps)({ operation: 'list' }, makeUserCtx());
    expect(objects.lastListInput?.limit).toBe(7);
  });

  test('passes opaque cursor through verbatim after validation', async () => {
    const objects = new ExtendedFakeObjectRepository();
    const cursor = encodeListCursor({
      lastCreatedAt: '2026-05-13T12:00:00.000Z',
      lastId: '00000000-0000-4000-8000-000000000050',
    });
    const deps = makeObjectsDeps({ objects });
    await createListObjectsHandler(deps)({ operation: 'list', cursor }, makeUserCtx());
    expect(objects.lastListInput?.cursor).toBe(cursor);
  });
});

describe('listObjectsHandler — cross-workspace isolation', () => {
  test('does NOT return rows from other workspaces', async () => {
    const objects = new ExtendedFakeObjectRepository();
    objects.seed(
      makeObject({ workspaceId: TEST_WORKSPACE_ID, status: 'ready' }),
      makeObject({ workspaceId: OTHER_WORKSPACE_ID, status: 'ready' }),
    );
    const res = await createListObjectsHandler(makeObjectsDeps({ objects }))(
      { operation: 'list' },
      makeUserCtx(),
    );
    expect(res.items.length).toBe(1);
    for (const item of res.items) {
      expect(item.workspaceId).toBe(TEST_WORKSPACE_ID);
    }
  });
});

describe('listObjectsHandler — defensive filtering', () => {
  test('strips any deleted row that slips through the repo', async () => {
    const objects = new ExtendedFakeObjectRepository();
    const hostile = makeObject({ status: 'ready' });
    objects.listResultOverride = {
      items: [
        hostile,
        { ...hostile, id: '00000000-0000-4000-8000-000000000099', status: 'deleted' },
      ],
      nextCursor: null,
    };
    const res = await createListObjectsHandler(makeObjectsDeps({ objects }))(
      { operation: 'list' },
      makeUserCtx(),
    );
    expect(res.items.length).toBe(1);
    expect(res.items[0].id).toBe(hostile.id);
  });

  test('refuses createdAfter > createdBefore', async () => {
    const deps = makeObjectsDeps();
    await expect(
      createListObjectsHandler(deps)(
        {
          operation: 'list',
          filters: {
            createdAfter: '2026-12-31T00:00:00.000Z',
            createdBefore: '2026-01-01T00:00:00.000Z',
          },
        },
        makeUserCtx(),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('listObjectsHandler — validation errors', () => {
  test('rejects unknown field', async () => {
    await expect(
      createListObjectsHandler(makeObjectsDeps())({ operation: 'list', hostile: 1 }, makeUserCtx()),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('rejects malformed cursor', async () => {
    await expect(
      createListObjectsHandler(makeObjectsDeps())(
        { operation: 'list', cursor: 'not-base64-json' },
        makeUserCtx(),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('rejects non-whitelisted status', async () => {
    await expect(
      createListObjectsHandler(makeObjectsDeps())(
        { operation: 'list', filters: { status: 'deleted' } },
        makeUserCtx(),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('listObjectsHandler — response shape', () => {
  test('never echoes provider fields', async () => {
    const objects = new ExtendedFakeObjectRepository();
    objects.seed(
      makeObject({
        providerObjectKey: 'workspaces/x/objects/y/leak.bin',
        providerId: 'provider-id-leak',
      }),
    );
    const res = await createListObjectsHandler(makeObjectsDeps({ objects }))(
      { operation: 'list' },
      makeUserCtx(),
    );
    assertNoForbiddenFields(res);
  });

  test('returns nextCursor null when repo says so', async () => {
    const objects = new ExtendedFakeObjectRepository();
    objects.seed(makeObject());
    const res = await createListObjectsHandler(makeObjectsDeps({ objects }))(
      { operation: 'list' },
      makeUserCtx(),
    );
    expect(res.nextCursor).toBeNull();
  });

  test('propagates nextCursor when repo provides one', async () => {
    const objects = new ExtendedFakeObjectRepository();
    objects.listResultOverride = {
      items: [makeObject()],
      nextCursor: 'opaque-next-cursor',
    };
    const res = await createListObjectsHandler(makeObjectsDeps({ objects }))(
      { operation: 'list' },
      makeUserCtx(),
    );
    expect(res.nextCursor).toBe('opaque-next-cursor');
  });
});
