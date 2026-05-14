/**
 * STORAGE-5 — upload action dispatcher tests.
 *
 * The gateway funnels create / complete / abort to one action key
 * (`platform.storage.objects.upload`); the storage-service distinguishes
 * via the payload-level `operation` discriminator.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  STORAGE_UPLOAD_ACTION_KEY,
  buildUploadActionHandler,
  registerUploadActionHandlers,
} from '../../../../src/actions/handlers/uploads';
import { __resetRegistry, getHandler } from '../../../../src/actions/registry';
import { ValidationError } from '../../../../src/actions/errors';
import { makeDeps, makeUserCtx } from './_fakes';

afterEach(() => {
  __resetRegistry();
});

describe('STORAGE_UPLOAD_ACTION_KEY', () => {
  test('matches the gateway-seeded action key', () => {
    expect(STORAGE_UPLOAD_ACTION_KEY).toBe('platform.storage.objects.upload');
  });
});

describe('buildUploadActionHandler — payload routing', () => {
  test('rejects missing operation field', async () => {
    const handler = buildUploadActionHandler(makeDeps());
    await expect(handler({}, makeUserCtx())).rejects.toBeInstanceOf(ValidationError);
  });

  test('rejects payload that is not an object', async () => {
    const handler = buildUploadActionHandler(makeDeps());
    await expect(handler('nope', makeUserCtx())).rejects.toBeInstanceOf(ValidationError);
    await expect(handler(null, makeUserCtx())).rejects.toBeInstanceOf(ValidationError);
    await expect(handler(42, makeUserCtx())).rejects.toBeInstanceOf(ValidationError);
  });

  test('rejects unknown operation', async () => {
    const handler = buildUploadActionHandler(makeDeps());
    await expect(handler({ operation: 'launch' }, makeUserCtx())).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  test('routes operation=create to the create handler', async () => {
    const handler = buildUploadActionHandler(makeDeps());
    const res = await handler(
      {
        operation: 'create',
        filename: 'a.bin',
        contentType: 'application/octet-stream',
        byteSize: 1,
      },
      makeUserCtx(),
    );
    expect(res).toMatchObject({ uploadMethod: 'single' });
  });

  test('routes operation=complete to the complete handler', async () => {
    const deps = makeDeps();
    const handler = buildUploadActionHandler(deps);
    // First create a session, then complete it.
    const createRes = (await handler(
      {
        operation: 'create',
        filename: 'a.bin',
        contentType: 'application/octet-stream',
        byteSize: 1,
      },
      makeUserCtx(),
    )) as { uploadId: string };
    const completeRes = (await handler(
      { operation: 'complete', uploadId: createRes.uploadId },
      makeUserCtx(),
    )) as { session: { status: string } };
    expect(completeRes.session.status).toBe('completed');
  });

  test('routes operation=abort to the abort handler', async () => {
    const deps = makeDeps();
    const handler = buildUploadActionHandler(deps);
    const createRes = (await handler(
      {
        operation: 'create',
        filename: 'a.bin',
        contentType: 'application/octet-stream',
        byteSize: 1,
      },
      makeUserCtx(),
    )) as { uploadId: string };
    const abortRes = (await handler(
      { operation: 'abort', uploadId: createRes.uploadId },
      makeUserCtx(),
    )) as { session: { status: string } };
    expect(abortRes.session.status).toBe('aborted');
  });
});

describe('registerUploadActionHandlers', () => {
  test('registers the upload action handler against the canonical action key', () => {
    __resetRegistry();
    expect(getHandler(STORAGE_UPLOAD_ACTION_KEY)).toBeUndefined();
    registerUploadActionHandlers(makeDeps());
    expect(getHandler(STORAGE_UPLOAD_ACTION_KEY)).toBeDefined();
  });
});
