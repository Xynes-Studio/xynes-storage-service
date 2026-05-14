/**
 * STORAGE-6 — action-key dispatcher tests.
 *
 * Covers three dispatchers + the `registerObjectActionHandlers` wiring:
 *   - `platform.storage.objects.read`   — list / get / download_url
 *   - `platform.storage.objects.delete` — delete
 *   - `platform.storage.usage.read`     — usage
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ValidationError } from '../../../../src/actions/errors';
import {
  STORAGE_OBJECTS_DELETE_ACTION_KEY,
  STORAGE_OBJECTS_READ_ACTION_KEY,
  STORAGE_USAGE_READ_ACTION_KEY,
  buildObjectsDeleteActionHandler,
  buildObjectsReadActionHandler,
  buildUsageReadActionHandler,
  registerObjectActionHandlers,
} from '../../../../src/actions/handlers/objects';
import { __resetRegistry, getHandler } from '../../../../src/actions/registry';
import {
  ExtendedFakeObjectRepository,
  ExtendedFakeProviderResolver,
  makeObject,
  makeObjectsDeps,
  makeUserCtx,
} from './_fakes';

afterEach(() => {
  __resetRegistry();
});

describe('action key constants', () => {
  test('read key matches gateway seed', () => {
    expect(STORAGE_OBJECTS_READ_ACTION_KEY).toBe('platform.storage.objects.read');
  });

  test('delete key matches gateway seed', () => {
    expect(STORAGE_OBJECTS_DELETE_ACTION_KEY).toBe('platform.storage.objects.delete');
  });

  test('usage key matches catalog entry', () => {
    expect(STORAGE_USAGE_READ_ACTION_KEY).toBe('platform.storage.usage.read');
  });
});

describe('buildObjectsReadActionHandler — routing', () => {
  test('rejects missing operation', async () => {
    await expect(
      buildObjectsReadActionHandler(makeObjectsDeps())({}, makeUserCtx()),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('rejects non-object payload', async () => {
    await expect(
      buildObjectsReadActionHandler(makeObjectsDeps())(null, makeUserCtx()),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      buildObjectsReadActionHandler(makeObjectsDeps())('nope', makeUserCtx()),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('rejects unknown operation', async () => {
    await expect(
      buildObjectsReadActionHandler(makeObjectsDeps())({ operation: 'launch' }, makeUserCtx()),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('routes operation=list', async () => {
    const objects = new ExtendedFakeObjectRepository();
    objects.seed(makeObject({ status: 'ready' }));
    const res = (await buildObjectsReadActionHandler(makeObjectsDeps({ objects }))(
      { operation: 'list' },
      makeUserCtx(),
    )) as { items: unknown[] };
    expect(Array.isArray(res.items)).toBe(true);
  });

  test('routes operation=get', async () => {
    const objects = new ExtendedFakeObjectRepository();
    const obj = makeObject({ status: 'ready' });
    objects.seed(obj);
    const res = (await buildObjectsReadActionHandler(makeObjectsDeps({ objects }))(
      { operation: 'get', objectId: obj.id },
      makeUserCtx(),
    )) as { object: { id: string } };
    expect(res.object.id).toBe(obj.id);
  });

  test('routes operation=download_url', async () => {
    const objects = new ExtendedFakeObjectRepository();
    const obj = makeObject({ status: 'ready' });
    objects.seed(obj);
    const providers = new ExtendedFakeProviderResolver({ providerId: obj.providerId });
    const res = (await buildObjectsReadActionHandler(makeObjectsDeps({ objects, providers }))(
      { operation: 'download_url', objectId: obj.id },
      makeUserCtx(),
    )) as { url: string };
    expect(typeof res.url).toBe('string');
  });
});

describe('buildObjectsDeleteActionHandler — routing', () => {
  test('rejects missing operation', async () => {
    await expect(
      buildObjectsDeleteActionHandler(makeObjectsDeps())({}, makeUserCtx()),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('rejects wrong operation', async () => {
    await expect(
      buildObjectsDeleteActionHandler(makeObjectsDeps())({ operation: 'list' }, makeUserCtx()),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('routes operation=delete', async () => {
    const objects = new ExtendedFakeObjectRepository();
    const obj = makeObject({ status: 'ready' });
    objects.seed(obj);
    const providers = new ExtendedFakeProviderResolver({ providerId: obj.providerId });
    const res = (await buildObjectsDeleteActionHandler(makeObjectsDeps({ objects, providers }))(
      { operation: 'delete', objectId: obj.id },
      makeUserCtx(),
    )) as { object: { status: string } };
    expect(res.object.status).toBe('deleted');
  });
});

describe('buildUsageReadActionHandler — routing', () => {
  test('rejects missing operation', async () => {
    await expect(
      buildUsageReadActionHandler(makeObjectsDeps())({}, makeUserCtx()),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('rejects wrong operation', async () => {
    await expect(
      buildUsageReadActionHandler(makeObjectsDeps())({ operation: 'list' }, makeUserCtx()),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('routes operation=usage', async () => {
    const now = () => new Date('2026-05-13T12:00:00.000Z');
    const res = (await buildUsageReadActionHandler(makeObjectsDeps({ now }))(
      { operation: 'usage' },
      makeUserCtx(),
    )) as { from: string; to: string };
    expect(res.from).toBe('2026-04-14');
    expect(res.to).toBe('2026-05-13');
  });
});

describe('registerObjectActionHandlers', () => {
  test('wires all three action keys in the registry', () => {
    registerObjectActionHandlers(makeObjectsDeps());
    expect(getHandler(STORAGE_OBJECTS_READ_ACTION_KEY)).toBeDefined();
    expect(getHandler(STORAGE_OBJECTS_DELETE_ACTION_KEY)).toBeDefined();
    expect(getHandler(STORAGE_USAGE_READ_ACTION_KEY)).toBeDefined();
  });
});
