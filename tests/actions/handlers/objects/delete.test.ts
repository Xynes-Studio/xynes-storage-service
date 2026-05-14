/**
 * STORAGE-6 — delete handler tests.
 *
 * Covers:
 *   - Happy path: soft-deletes row + best-effort provider delete.
 *   - Already-deleted is idempotent (no second provider call).
 *   - Unknown / cross-workspace return "not found".
 *   - ProviderAdapterError on provider delete is SWALLOWED; local row still flips.
 *   - Non-ProviderAdapterError IS re-thrown.
 *   - Provider-unavailable: soft-delete succeeds anyway.
 *   - Race-loss: `softDeleteForWorkspace` returns null, re-read resolves to
 *     `deleted` -> idempotent success.
 *   - Deleted object no longer produces a download URL (smoke via handler chain).
 *   - Response shape redaction.
 */
import { describe, expect, test } from 'bun:test';
import { ValidationError } from '../../../../src/actions/errors';
import { ProviderAdapterError } from '../../../../src/infra/providers/errors';
import { createDeleteObjectHandler } from '../../../../src/actions/handlers/objects/delete';
import { createDownloadUrlHandler } from '../../../../src/actions/handlers/objects/download-url';
import {
  ExtendedFakeObjectRepository,
  ExtendedFakeProviderResolver,
  OTHER_WORKSPACE_ID,
  makeObject,
  makeObjectsDeps,
  makeUserCtx,
} from './_fakes';

const FORBIDDEN = [
  'provider_kind',
  'providerKind',
  'providerId',
  'providerObjectKey',
  'credential_ref',
  'endpoint',
  'region',
  'bucket',
  'accessKeyId',
  'secretAccessKey',
];

function assertNoForbidden(payload: unknown): void {
  const json = JSON.stringify(payload);
  for (const f of FORBIDDEN) expect(json).not.toContain(`"${f}"`);
}

describe('deleteObjectHandler — happy paths', () => {
  test('soft-deletes a ready object and calls provider delete', async () => {
    const objects = new ExtendedFakeObjectRepository();
    const obj = makeObject({ status: 'ready' });
    objects.seed(obj);
    const providers = new ExtendedFakeProviderResolver({ providerId: obj.providerId });
    const res = await createDeleteObjectHandler(makeObjectsDeps({ objects, providers }))(
      { operation: 'delete', objectId: obj.id },
      makeUserCtx(),
    );
    expect(res.object.status).toBe('deleted');
    expect(providers.adapter.calls.find((c) => c.method === 'deleteObject')).toBeTruthy();
    expect(providers.resolveByProviderIdCount).toBe(1);
  });

  test('idempotent on already-deleted (no second provider call)', async () => {
    const objects = new ExtendedFakeObjectRepository();
    const obj = makeObject({ status: 'deleted' });
    objects.seed(obj);
    const providers = new ExtendedFakeProviderResolver({ providerId: obj.providerId });
    const res = await createDeleteObjectHandler(makeObjectsDeps({ objects, providers }))(
      { operation: 'delete', objectId: obj.id },
      makeUserCtx(),
    );
    expect(res.object.status).toBe('deleted');
    expect(providers.adapter.calls.filter((c) => c.method === 'deleteObject').length).toBe(0);
    expect(providers.resolveByProviderIdCount).toBe(0);
  });
});

describe('deleteObjectHandler — error envelopes', () => {
  test('unknown object returns "not found"', async () => {
    await expect(
      createDeleteObjectHandler(makeObjectsDeps())(
        { operation: 'delete', objectId: '00000000-0000-4000-8000-aaaaaaaaaaaa' },
        makeUserCtx(),
      ),
    ).rejects.toMatchObject({ name: 'ValidationError', message: 'Object not found' });
  });

  test('cross-workspace returns "not found"', async () => {
    const objects = new ExtendedFakeObjectRepository();
    const foreign = makeObject({ workspaceId: OTHER_WORKSPACE_ID, status: 'ready' });
    objects.seed(foreign);
    await expect(
      createDeleteObjectHandler(makeObjectsDeps({ objects }))(
        { operation: 'delete', objectId: foreign.id },
        makeUserCtx(),
      ),
    ).rejects.toMatchObject({ message: 'Object not found' });
  });
});

describe('deleteObjectHandler — provider error swallowing', () => {
  test('ProviderAdapterError is swallowed; local row still flips', async () => {
    const objects = new ExtendedFakeObjectRepository();
    const obj = makeObject({ status: 'ready' });
    objects.seed(obj);
    const providers = new ExtendedFakeProviderResolver({ providerId: obj.providerId });
    providers.adapter.deleteObjectImpl = async () => {
      throw new ProviderAdapterError('PROVIDER_OPERATION_FAILED', 'provider transient error');
    };
    const res = await createDeleteObjectHandler(makeObjectsDeps({ objects, providers }))(
      { operation: 'delete', objectId: obj.id },
      makeUserCtx(),
    );
    expect(res.object.status).toBe('deleted');
  });

  test('non-ProviderAdapterError is re-thrown', async () => {
    const objects = new ExtendedFakeObjectRepository();
    const obj = makeObject({ status: 'ready' });
    objects.seed(obj);
    const providers = new ExtendedFakeProviderResolver({ providerId: obj.providerId });
    providers.adapter.deleteObjectImpl = async () => {
      throw new Error('programming bug');
    };
    await expect(
      createDeleteObjectHandler(makeObjectsDeps({ objects, providers }))(
        { operation: 'delete', objectId: obj.id },
        makeUserCtx(),
      ),
    ).rejects.toThrow('programming bug');
    // Row IS still soft-deleted because we re-throw AFTER the DB flip.
    const after = objects.objects.get(obj.id);
    expect(after?.status).toBe('deleted');
  });

  test('provider-resolver miss: local row still flips, no throw', async () => {
    const objects = new ExtendedFakeObjectRepository();
    const obj = makeObject({ status: 'ready' });
    objects.seed(obj);
    const providers = new ExtendedFakeProviderResolver({ providerId: 'some-other' });
    providers.unavailableProviderIds.add(obj.providerId);
    const res = await createDeleteObjectHandler(makeObjectsDeps({ objects, providers }))(
      { operation: 'delete', objectId: obj.id },
      makeUserCtx(),
    );
    expect(res.object.status).toBe('deleted');
  });
});

describe('deleteObjectHandler — race-loss path', () => {
  test('repo returns null but re-read resolves to deleted -> idempotent', async () => {
    const objects = new ExtendedFakeObjectRepository();
    const obj = makeObject({ status: 'ready' });
    objects.seed(obj);
    // Simulate: another request raced in and already soft-deleted.
    objects.failSoftDelete = true;
    objects.setStatus(obj.id, 'deleted');
    const res = await createDeleteObjectHandler(makeObjectsDeps({ objects }))(
      { operation: 'delete', objectId: obj.id },
      makeUserCtx(),
    );
    expect(res.object.status).toBe('deleted');
  });

  test('repo returns null AND re-read still says ready -> "not found"', async () => {
    // Defensive guard: programmer-error path where softDelete fails but
    // the row didn't actually flip. Surfaces as "not found" rather than
    // misleading the caller.
    const objects = new ExtendedFakeObjectRepository();
    const obj = makeObject({ status: 'ready' });
    objects.seed(obj);
    objects.failSoftDelete = true;
    await expect(
      createDeleteObjectHandler(makeObjectsDeps({ objects }))(
        { operation: 'delete', objectId: obj.id },
        makeUserCtx(),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('deleteObjectHandler — interaction with downloadUrl', () => {
  test('deleted object no longer produces a download URL', async () => {
    const objects = new ExtendedFakeObjectRepository();
    const obj = makeObject({ status: 'ready' });
    objects.seed(obj);
    const providers = new ExtendedFakeProviderResolver({ providerId: obj.providerId });
    const deps = makeObjectsDeps({ objects, providers });
    await createDeleteObjectHandler(deps)({ operation: 'delete', objectId: obj.id }, makeUserCtx());
    await expect(
      createDownloadUrlHandler(deps)(
        { operation: 'download_url', objectId: obj.id },
        makeUserCtx(),
      ),
    ).rejects.toMatchObject({ message: 'Object not found' });
  });
});

describe('deleteObjectHandler — validation + response', () => {
  test('rejects non-UUID objectId', async () => {
    await expect(
      createDeleteObjectHandler(makeObjectsDeps())(
        { operation: 'delete', objectId: 'x' },
        makeUserCtx(),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('response shape has no provider fields', async () => {
    const objects = new ExtendedFakeObjectRepository();
    const obj = makeObject({
      status: 'ready',
      providerObjectKey: 'workspaces/x/objects/y/leak.bin',
      providerId: 'leaky-provider',
    });
    objects.seed(obj);
    const providers = new ExtendedFakeProviderResolver({ providerId: obj.providerId });
    const res = await createDeleteObjectHandler(makeObjectsDeps({ objects, providers }))(
      { operation: 'delete', objectId: obj.id },
      makeUserCtx(),
    );
    assertNoForbidden(res);
  });
});
