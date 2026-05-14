/**
 * STORAGE-6 — download URL handler tests.
 *
 * Covers:
 *   - Happy path for each deliverable status (uploaded, processing, ready, failed).
 *   - Refuses pending_upload (object not yet on provider).
 *   - Refuses deleted / cross-workspace / unknown (same "not found" envelope).
 *   - Resolves provider by providerId, NOT by workspace default.
 *   - Resolver-miss surfaces as 403 ForbiddenError with non-leaky message.
 *   - TTL plumbing: default vs. caller-supplied.
 *   - downloadFilename plumbing.
 *   - Response is exactly `{ objectId, url, expiresAt }`.
 *   - Provider-config-leak negative tests across R2 / B2 / iDrive e2 / AWS S3 / MinIO.
 */
import { describe, expect, test } from 'bun:test';
import { ForbiddenError, ValidationError } from '../../../../src/actions/errors';
import { createDownloadUrlHandler } from '../../../../src/actions/handlers/objects/download-url';
import type { ProviderKind } from '../../../../src/infra/providers/types';
import {
  ExtendedFakeObjectRepository,
  ExtendedFakeProviderResolver,
  FakeStorageAdapter,
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

describe('downloadUrlHandler — happy paths', () => {
  for (const status of ['uploaded', 'processing', 'ready', 'failed'] as const) {
    test(`signs URL for status=${status}`, async () => {
      const objects = new ExtendedFakeObjectRepository();
      const obj = makeObject({ status });
      objects.seed(obj);
      const providers = new ExtendedFakeProviderResolver({ providerId: obj.providerId });
      const res = await createDownloadUrlHandler(makeObjectsDeps({ objects, providers }))(
        { operation: 'download_url', objectId: obj.id },
        makeUserCtx(),
      );
      expect(res.objectId).toBe(obj.id);
      expect(res.url).toContain(obj.providerObjectKey);
      expect(typeof res.expiresAt).toBe('string');
      expect(providers.resolveByProviderIdCount).toBe(1);
      expect(providers.resolveDefaultCount).toBe(0);
    });
  }

  test('passes caller-supplied TTL through to the adapter', async () => {
    const objects = new ExtendedFakeObjectRepository();
    const obj = makeObject({ status: 'ready' });
    objects.seed(obj);
    const providers = new ExtendedFakeProviderResolver({ providerId: obj.providerId });
    await createDownloadUrlHandler(makeObjectsDeps({ objects, providers }))(
      { operation: 'download_url', objectId: obj.id, expiresInSeconds: 600 },
      makeUserCtx(),
    );
    const call = providers.adapter.calls.find((c) => c.method === 'createDownloadUrl');
    expect((call?.opts as { expiresInSeconds?: number }).expiresInSeconds).toBe(600);
  });

  test('passes downloadFilename through to the adapter', async () => {
    const objects = new ExtendedFakeObjectRepository();
    const obj = makeObject({ status: 'ready' });
    objects.seed(obj);
    const providers = new ExtendedFakeProviderResolver({ providerId: obj.providerId });
    await createDownloadUrlHandler(makeObjectsDeps({ objects, providers }))(
      { operation: 'download_url', objectId: obj.id, downloadFilename: 'invoice.pdf' },
      makeUserCtx(),
    );
    const call = providers.adapter.calls.find((c) => c.method === 'createDownloadUrl');
    expect((call?.opts as { downloadFilename?: string }).downloadFilename).toBe('invoice.pdf');
  });

  test('uses defaultDownloadTtlSeconds when caller omits TTL', async () => {
    const objects = new ExtendedFakeObjectRepository();
    const obj = makeObject({ status: 'ready' });
    objects.seed(obj);
    const providers = new ExtendedFakeProviderResolver({ providerId: obj.providerId });
    await createDownloadUrlHandler(
      makeObjectsDeps({ objects, providers, defaultDownloadTtlSeconds: 333 }),
    )({ operation: 'download_url', objectId: obj.id }, makeUserCtx());
    const call = providers.adapter.calls.find((c) => c.method === 'createDownloadUrl');
    expect((call?.opts as { expiresInSeconds?: number }).expiresInSeconds).toBe(333);
  });

  test('response is exactly {objectId, url, expiresAt} — no extra keys', async () => {
    const objects = new ExtendedFakeObjectRepository();
    const obj = makeObject({ status: 'ready' });
    objects.seed(obj);
    const providers = new ExtendedFakeProviderResolver({ providerId: obj.providerId });
    const res = await createDownloadUrlHandler(makeObjectsDeps({ objects, providers }))(
      { operation: 'download_url', objectId: obj.id },
      makeUserCtx(),
    );
    expect(new Set(Object.keys(res))).toEqual(new Set(['objectId', 'url', 'expiresAt']));
  });
});

describe('downloadUrlHandler — not-found paths', () => {
  test('unknown object', async () => {
    await expect(
      createDownloadUrlHandler(makeObjectsDeps())(
        {
          operation: 'download_url',
          objectId: '00000000-0000-4000-8000-aaaaaaaaaaaa',
        },
        makeUserCtx(),
      ),
    ).rejects.toMatchObject({ name: 'ValidationError', message: 'Object not found' });
  });

  test('cross-workspace returns "not found"', async () => {
    const objects = new ExtendedFakeObjectRepository();
    const foreign = makeObject({ workspaceId: OTHER_WORKSPACE_ID, status: 'ready' });
    objects.seed(foreign);
    await expect(
      createDownloadUrlHandler(makeObjectsDeps({ objects }))(
        { operation: 'download_url', objectId: foreign.id },
        makeUserCtx(),
      ),
    ).rejects.toMatchObject({ message: 'Object not found' });
  });

  test('deleted object returns "not found"', async () => {
    const objects = new ExtendedFakeObjectRepository();
    const o = makeObject({ status: 'deleted' });
    objects.seed(o);
    await expect(
      createDownloadUrlHandler(makeObjectsDeps({ objects }))(
        { operation: 'download_url', objectId: o.id },
        makeUserCtx(),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('pending_upload object returns "not yet available"', async () => {
    const objects = new ExtendedFakeObjectRepository();
    const o = makeObject({ status: 'pending_upload' });
    objects.seed(o);
    await expect(
      createDownloadUrlHandler(makeObjectsDeps({ objects }))(
        { operation: 'download_url', objectId: o.id },
        makeUserCtx(),
      ),
    ).rejects.toMatchObject({
      name: 'ValidationError',
      message: 'Object is not yet available for download',
    });
  });
});

describe('downloadUrlHandler — provider resolution', () => {
  test('returns 403 Forbidden when provider is gone, with redacted message', async () => {
    const objects = new ExtendedFakeObjectRepository();
    const obj = makeObject({ status: 'ready', providerId: '00000000-0000-4000-8000-0000000000bb' });
    objects.seed(obj);
    const providers = new ExtendedFakeProviderResolver({
      providerId: '00000000-0000-4000-8000-0000000000a0', // different from obj.providerId
    });
    providers.unavailableProviderIds.add(obj.providerId);
    await expect(
      createDownloadUrlHandler(makeObjectsDeps({ objects, providers }))(
        { operation: 'download_url', objectId: obj.id },
        makeUserCtx(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // Sanity: message MUST NOT leak provider config.
    try {
      await createDownloadUrlHandler(makeObjectsDeps({ objects, providers }))(
        { operation: 'download_url', objectId: obj.id },
        makeUserCtx(),
      );
    } catch (e) {
      const msg = (e as Error).message;
      for (const f of FORBIDDEN) expect(msg).not.toContain(f);
      expect(msg).not.toMatch(/[A-Fa-f0-9]{16,}/); // no long hex (no provider id leak).
    }
  });

  test('always resolves by providerId, not by workspace default', async () => {
    const objects = new ExtendedFakeObjectRepository();
    const obj = makeObject({ status: 'ready' });
    objects.seed(obj);
    const providers = new ExtendedFakeProviderResolver({ providerId: obj.providerId });
    await createDownloadUrlHandler(makeObjectsDeps({ objects, providers }))(
      { operation: 'download_url', objectId: obj.id },
      makeUserCtx(),
    );
    expect(providers.resolveByProviderIdCount).toBe(1);
    expect(providers.resolveDefaultCount).toBe(0);
  });
});

describe('downloadUrlHandler — response shape redaction across providers', () => {
  for (const kind of ['r2', 'b2', 'idrive_e2', 'aws_s3', 'minio'] as ProviderKind[]) {
    test(`provider=${kind}: response has no per-provider field`, async () => {
      const adapter = new FakeStorageAdapter(kind);
      const providers = new ExtendedFakeProviderResolver({
        providerId: '00000000-0000-4000-8000-0000000000a0',
        adapter,
      });
      const objects = new ExtendedFakeObjectRepository();
      const obj = makeObject({
        status: 'ready',
        providerObjectKey: 'workspaces/x/objects/y/leak.bin',
        providerId: providers.providerId,
      });
      objects.seed(obj);
      const res = await createDownloadUrlHandler(makeObjectsDeps({ objects, providers }))(
        { operation: 'download_url', objectId: obj.id },
        makeUserCtx(),
      );
      assertNoForbidden(res);
    });
  }
});

describe('downloadUrlHandler — validation', () => {
  test('rejects malformed objectId', async () => {
    await expect(
      createDownloadUrlHandler(makeObjectsDeps())(
        { operation: 'download_url', objectId: 'nope' },
        makeUserCtx(),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('rejects header-injection downloadFilename', async () => {
    const objects = new ExtendedFakeObjectRepository();
    const obj = makeObject({ status: 'ready' });
    objects.seed(obj);
    await expect(
      createDownloadUrlHandler(makeObjectsDeps({ objects }))(
        {
          operation: 'download_url',
          objectId: obj.id,
          downloadFilename: 'evil\r\n',
        },
        makeUserCtx(),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
