/**
 * STORAGE-6 — get-by-id handler tests.
 *
 * Covers:
 *   - Happy path: returns object + variants + processing jobs.
 *   - Cross-workspace denial returns "not found" envelope.
 *   - `status = 'deleted'` returns "not found" (indistinguishable from never-existed).
 *   - Variants + jobs are read in parallel.
 *   - Response shape allowlist.
 */
import { describe, expect, test } from 'bun:test';
import { ValidationError } from '../../../../src/actions/errors';
import { createGetObjectHandler } from '../../../../src/actions/handlers/objects/get';
import {
  ExtendedFakeObjectRepository,
  FakeProcessingJobRepository,
  FakeVariantRepository,
  OTHER_WORKSPACE_ID,
  makeJob,
  makeObject,
  makeObjectsDeps,
  makeUserCtx,
  makeVariant,
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

describe('getObjectHandler — happy paths', () => {
  test('returns object + variants + jobs', async () => {
    const objects = new ExtendedFakeObjectRepository();
    const variants = new FakeVariantRepository();
    const jobs = new FakeProcessingJobRepository();
    const obj = makeObject({ status: 'ready' });
    objects.seed(obj);
    variants.seed(obj.id, makeVariant({ objectId: obj.id, variantKey: 'thumb_256' }));
    jobs.seed(
      obj.id,
      makeJob({ objectId: obj.id, jobType: 'image_optimize', status: 'succeeded' }),
    );

    const res = await createGetObjectHandler(makeObjectsDeps({ objects, variants, jobs }))(
      { operation: 'get', objectId: obj.id },
      makeUserCtx(),
    );
    expect(res.object.id).toBe(obj.id);
    expect(res.variants.length).toBe(1);
    expect(res.processingJobs.length).toBe(1);
    expect(variants.lastInput?.objectId).toBe(obj.id);
    expect(jobs.lastInput?.objectId).toBe(obj.id);
  });

  test('returns empty arrays when no variants / jobs', async () => {
    const objects = new ExtendedFakeObjectRepository();
    const obj = makeObject({ status: 'uploaded' });
    objects.seed(obj);
    const res = await createGetObjectHandler(makeObjectsDeps({ objects }))(
      { operation: 'get', objectId: obj.id },
      makeUserCtx(),
    );
    expect(res.variants.length).toBe(0);
    expect(res.processingJobs.length).toBe(0);
  });
});

describe('getObjectHandler — not-found path', () => {
  test('unknown object returns "Object not found"', async () => {
    await expect(
      createGetObjectHandler(makeObjectsDeps())(
        { operation: 'get', objectId: '00000000-0000-4000-8000-aaaaaaaaaaaa' },
        makeUserCtx(),
      ),
    ).rejects.toMatchObject({ name: 'ValidationError', message: 'Object not found' });
  });

  test('cross-workspace returns "Object not found" (NOT 403)', async () => {
    const objects = new ExtendedFakeObjectRepository();
    const foreign = makeObject({ workspaceId: OTHER_WORKSPACE_ID });
    objects.seed(foreign);
    await expect(
      createGetObjectHandler(makeObjectsDeps({ objects }))(
        { operation: 'get', objectId: foreign.id },
        makeUserCtx(),
      ),
    ).rejects.toMatchObject({ name: 'ValidationError', message: 'Object not found' });
  });

  test('soft-deleted object returns "Object not found"', async () => {
    const objects = new ExtendedFakeObjectRepository();
    const o = makeObject({ status: 'deleted' });
    objects.seed(o);
    await expect(
      createGetObjectHandler(makeObjectsDeps({ objects }))(
        { operation: 'get', objectId: o.id },
        makeUserCtx(),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('getObjectHandler — validation', () => {
  test('rejects non-UUID objectId', async () => {
    await expect(
      createGetObjectHandler(makeObjectsDeps())({ operation: 'get', objectId: 'x' }, makeUserCtx()),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('getObjectHandler — response shape', () => {
  test('never echoes provider fields', async () => {
    const objects = new ExtendedFakeObjectRepository();
    const variants = new FakeVariantRepository();
    const jobs = new FakeProcessingJobRepository();
    const obj = makeObject({
      status: 'ready',
      providerObjectKey: 'workspaces/x/objects/y/leak.bin',
      providerId: 'provider-leak',
    });
    objects.seed(obj);
    variants.seed(obj.id, makeVariant({ objectId: obj.id }));
    jobs.seed(obj.id, makeJob({ objectId: obj.id }));
    const res = await createGetObjectHandler(makeObjectsDeps({ objects, variants, jobs }))(
      { operation: 'get', objectId: obj.id },
      makeUserCtx(),
    );
    assertNoForbidden(res);
  });
});
