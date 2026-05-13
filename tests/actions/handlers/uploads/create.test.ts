/**
 * STORAGE-5 — `create` upload session handler tests.
 *
 * Covers:
 *   - Happy-path single + multipart.
 *   - Default values (purpose, visibility, compression).
 *   - Single/multipart threshold logic.
 *   - Validation errors (strict schema).
 *   - "No provider configured" envelope.
 *   - Atomic create-with-session rollback when DB insert fails.
 *   - User actor vs api_key actor audit posture (createdBy population).
 *   - Response shape redaction — no provider config, no presigned URL
 *     signature parameters leak through documented fields.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  createCreateUploadHandler,
  planMultipartParts,
} from '../../../../src/actions/handlers/uploads/create';
import { ForbiddenError, ValidationError } from '../../../../src/actions/errors';
import {
  FakeProviderResolver,
  FakeRepositories,
  makeApiKeyCtx,
  makeDeps,
  makeDeterministicIds,
  makeUserCtx,
  TEST_USER_ID,
  TEST_WORKSPACE_ID,
} from './_fakes';

const TINY_PAYLOAD = {
  operation: 'create' as const,
  filename: 'photo.jpg',
  contentType: 'image/jpeg',
  byteSize: 1024,
};

const LARGE_PAYLOAD = {
  operation: 'create' as const,
  filename: 'video.mp4',
  contentType: 'video/mp4',
  byteSize: 250 * 1024 * 1024, // 250 MB — over the 100 MB default threshold.
};

describe('planMultipartParts', () => {
  test('returns 1 for tiny inputs', () => {
    expect(planMultipartParts(0)).toBe(1);
    expect(planMultipartParts(1)).toBe(1);
    expect(planMultipartParts(5 * 1024 * 1024)).toBe(1);
  });

  test('rounds up to part count for files just over the min', () => {
    // 6 MiB → 2 parts (5 MiB + 1 MiB).
    expect(planMultipartParts(6 * 1024 * 1024)).toBe(2);
    // 250 MB → ceil(250 / 5) = 50 parts.
    expect(planMultipartParts(250 * 1024 * 1024)).toBe(50);
  });

  test('caps at MULTIPART_MAX_PART_COUNT for very large files', () => {
    // 5 MiB × 10001 parts.
    const tooBig = 5 * 1024 * 1024 * 10001;
    expect(planMultipartParts(tooBig)).toBe(10_000);
  });
});

describe('createUploadHandler — happy paths', () => {
  let deps: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    deps = makeDeps();
  });

  test('returns a single PUT URL for small files', async () => {
    const handler = createCreateUploadHandler(deps);
    const res = await handler(TINY_PAYLOAD, makeUserCtx());
    expect(res.uploadMethod).toBe('single');
    expect(res.uploadUrl).toContain('https://');
    expect(res.parts).toEqual([]);
    expect(res.object.status).toBe('pending_upload');
    expect(res.object.filename).toBe('photo.jpg');
    expect(res.object.contentType).toBe('image/jpeg');
    expect(res.object.byteSize).toBe(1024);
  });

  test('returns multipart URLs for files over the threshold', async () => {
    const handler = createCreateUploadHandler(deps);
    const res = await handler(LARGE_PAYLOAD, makeUserCtx());
    expect(res.uploadMethod).toBe('multipart');
    expect(res.uploadUrl).toBeNull();
    expect(res.parts.length).toBe(50);
    expect(res.parts[0].partNumber).toBe(1);
    expect(res.parts[49].partNumber).toBe(50);
    for (const p of res.parts) {
      expect(p.url).toContain('https://');
      expect(p.expiresAt).toMatch(/T.*Z$/);
    }
  });

  test('configurable threshold flips method', async () => {
    const tight = makeDeps({ multipartThresholdBytes: 512 });
    const handler = createCreateUploadHandler(tight);
    const res = await handler(TINY_PAYLOAD, makeUserCtx()); // 1024 > 512.
    expect(res.uploadMethod).toBe('multipart');
  });

  test('defaults: purpose=platform_generic, visibility=private, compression=true', async () => {
    const handler = createCreateUploadHandler(deps);
    const res = await handler(TINY_PAYLOAD, makeUserCtx());
    expect(res.object.purpose).toBe('platform_generic');
    expect(res.object.visibility).toBe('private');
    expect(res.object.compressionRequested).toBe(true);
  });

  test('CMS callers can pass purpose=cms_media', async () => {
    const handler = createCreateUploadHandler(deps);
    const res = await handler({ ...TINY_PAYLOAD, purpose: 'cms_media' }, makeUserCtx());
    expect(res.object.purpose).toBe('cms_media');
  });

  test('allows compression=false override', async () => {
    const handler = createCreateUploadHandler(deps);
    const res = await handler({ ...TINY_PAYLOAD, compression: false }, makeUserCtx());
    expect(res.object.compressionRequested).toBe(false);
  });

  test('persists sha256 when supplied', async () => {
    const sha = 'a'.repeat(64);
    const handler = createCreateUploadHandler(deps);
    const res = await handler({ ...TINY_PAYLOAD, sha256: sha }, makeUserCtx());
    expect(res.object.sha256).toBe(sha);
  });

  test('createdBy = userId for user actor', async () => {
    const handler = createCreateUploadHandler(deps);
    const res = await handler(TINY_PAYLOAD, makeUserCtx());
    expect(res.object.createdBy).toBe(TEST_USER_ID);
  });

  test('createdBy = null for api_key actor (CMS-API-KEY-ACTOR-1 Story C parity)', async () => {
    const handler = createCreateUploadHandler(deps);
    const res = await handler(TINY_PAYLOAD, makeApiKeyCtx());
    expect(res.object.createdBy).toBeNull();
  });

  test('object id and session id come from idFactory', async () => {
    const idGen = makeDeterministicIds();
    const handler = createCreateUploadHandler(makeDeps({ idFactory: idGen.next }));
    const res = await handler(TINY_PAYLOAD, makeUserCtx());
    // First id minted → objectId, second → sessionId.
    expect(res.objectId).toBe(idGen.ids[0]);
    expect(res.uploadId).toBe(idGen.ids[1]);
  });

  test('expiresAt is in the future and matches session ttl', async () => {
    const now = new Date('2026-05-13T12:00:00.000Z');
    const handler = createCreateUploadHandler(makeDeps({ now: () => now, sessionTtlSeconds: 600 }));
    const res = await handler(TINY_PAYLOAD, makeUserCtx());
    const exp = new Date(res.expiresAt).getTime();
    expect(exp).toBe(now.getTime() + 600 * 1000);
  });
});

describe('createUploadHandler — validation errors', () => {
  let deps: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    deps = makeDeps();
  });

  test('rejects missing filename', async () => {
    const handler = createCreateUploadHandler(deps);
    await expect(
      handler({ operation: 'create', contentType: 'image/jpeg', byteSize: 1 }, makeUserCtx()),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('rejects empty filename', async () => {
    const handler = createCreateUploadHandler(deps);
    await expect(handler({ ...TINY_PAYLOAD, filename: '' }, makeUserCtx())).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  test('rejects filename with NUL byte', async () => {
    const handler = createCreateUploadHandler(deps);
    await expect(
      handler({ ...TINY_PAYLOAD, filename: 'evil\0name.jpg' }, makeUserCtx()),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('rejects negative byteSize', async () => {
    const handler = createCreateUploadHandler(deps);
    await expect(handler({ ...TINY_PAYLOAD, byteSize: -1 }, makeUserCtx())).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  test('rejects byteSize beyond the maximum', async () => {
    const handler = createCreateUploadHandler(deps);
    await expect(
      handler(
        { ...TINY_PAYLOAD, byteSize: 6 * 1024 * 1024 * 1024 /* 6 GiB > 5 GiB cap */ },
        makeUserCtx(),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('rejects unknown extra fields (strict schema)', async () => {
    const handler = createCreateUploadHandler(deps);
    await expect(
      handler({ ...TINY_PAYLOAD, sneaky: 'value' }, makeUserCtx()),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('rejects malformed sha256', async () => {
    const handler = createCreateUploadHandler(deps);
    await expect(
      handler({ ...TINY_PAYLOAD, sha256: 'not-hex' }, makeUserCtx()),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('rejects unsupported visibility', async () => {
    const handler = createCreateUploadHandler(deps);
    await expect(
      handler({ ...TINY_PAYLOAD, visibility: 'shared' }, makeUserCtx()),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('rejects bad purpose (non snake_case)', async () => {
    const handler = createCreateUploadHandler(deps);
    await expect(
      handler({ ...TINY_PAYLOAD, purpose: 'CMS Media' }, makeUserCtx()),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('createUploadHandler — provider not configured', () => {
  test('throws ForbiddenError with generic message (no provider config leakage)', async () => {
    const providers = new FakeProviderResolver();
    providers.unconfigured = true;
    const handler = createCreateUploadHandler(makeDeps({ providers }));
    try {
      await handler(TINY_PAYLOAD, makeUserCtx());
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenError);
      const msg = (err as Error).message;
      expect(msg).not.toContain('credential');
      expect(msg).not.toContain('endpoint');
      expect(msg).not.toContain('bucket');
      expect(msg).not.toContain('region');
      expect(msg).not.toMatch(/r2|b2|idrive|minio|s3/i);
    }
  });
});

describe('createUploadHandler — atomic insert + rollback', () => {
  test('aborts multipart on provider when DB insert fails', async () => {
    const repositories = new FakeRepositories();
    repositories.throwOnCreateOnce = new Error('boom-db');
    const providers = new FakeProviderResolver();
    const handler = createCreateUploadHandler(makeDeps({ repositories, providers }));
    await expect(handler(LARGE_PAYLOAD, makeUserCtx())).rejects.toThrow('boom-db');
    const aborts = providers.adapter.calls.filter((c) => c.method === 'abortMultipartUpload');
    expect(aborts.length).toBe(1);
  });

  test('does not call adapter.abortMultipartUpload for single uploads when DB insert fails', async () => {
    const repositories = new FakeRepositories();
    repositories.throwOnCreateOnce = new Error('boom-db');
    const providers = new FakeProviderResolver();
    const handler = createCreateUploadHandler(makeDeps({ repositories, providers }));
    await expect(handler(TINY_PAYLOAD, makeUserCtx())).rejects.toThrow('boom-db');
    const aborts = providers.adapter.calls.filter((c) => c.method === 'abortMultipartUpload');
    expect(aborts.length).toBe(0);
  });

  test('swallowed provider abort failure during rollback still re-throws original DB error', async () => {
    const repositories = new FakeRepositories();
    repositories.throwOnCreateOnce = new Error('boom-db');
    const providers = new FakeProviderResolver();
    providers.adapter.abortMultipartUploadImpl = async () => {
      throw new Error('provider abort glitch');
    };
    const handler = createCreateUploadHandler(makeDeps({ repositories, providers }));
    await expect(handler(LARGE_PAYLOAD, makeUserCtx())).rejects.toThrow('boom-db');
  });
});

describe('createUploadHandler — response shape redaction', () => {
  test('response contains documented fields only', async () => {
    const handler = createCreateUploadHandler(makeDeps());
    const res = await handler(TINY_PAYLOAD, makeUserCtx());

    const responseKeys = Object.keys(res).sort();
    expect(responseKeys).toEqual(
      [
        'expiresAt',
        'object',
        'objectId',
        'parts',
        'uploadHeaders',
        'uploadId',
        'uploadMethod',
        'uploadUrl',
      ].sort(),
    );

    const objectKeys = Object.keys(res.object).sort();
    // No `providerId`, `providerObjectKey`, `provider_kind`, `endpoint`, `region`, `bucket`.
    expect(objectKeys).not.toContain('providerId');
    expect(objectKeys).not.toContain('providerObjectKey');
    expect(objectKeys).not.toContain('provider_kind');
    expect(objectKeys).not.toContain('endpoint');
    expect(objectKeys).not.toContain('region');
    expect(objectKeys).not.toContain('bucket');
    expect(objectKeys).not.toContain('credentialRef');
    expect(objectKeys).not.toContain('credential_ref');
  });

  test('serialised response carries no provider config or credentials anywhere', async () => {
    const handler = createCreateUploadHandler(makeDeps());
    const res = await handler(TINY_PAYLOAD, makeUserCtx());
    const json = JSON.stringify(res);
    // Provider config keys MUST NOT appear as standalone JSON keys/values.
    // (We accept that the signed `uploadUrl` itself embeds the endpoint host.)
    expect(json).not.toMatch(/"provider_?kind"/);
    expect(json).not.toMatch(/"providerId"/);
    expect(json).not.toMatch(/"region"/);
    expect(json).not.toMatch(/"bucket"/);
    expect(json).not.toMatch(/"endpoint"/);
    expect(json).not.toMatch(/"credential_?ref"/);
    expect(json).not.toMatch(/"accessKeyId"/);
    expect(json).not.toMatch(/"secretAccessKey"/);
    expect(json).not.toMatch(/"providerObjectKey"/);
    // `providerUploadId` is an opaque multipart handle from the provider —
    // not a credential, but it must not appear in the public response either.
    expect(json).not.toMatch(/"providerUploadId"/);
  });

  test('object key is workspace-scoped and uses the minted UUID', async () => {
    const idGen = makeDeterministicIds();
    const providers = new FakeProviderResolver();
    const handler = createCreateUploadHandler(makeDeps({ idFactory: idGen.next, providers }));
    await handler(TINY_PAYLOAD, makeUserCtx());
    const singleCalls = providers.adapter.calls.filter((c) => c.method === 'createSingleUploadUrl');
    expect(singleCalls.length).toBe(1);
    const opts = singleCalls[0].opts as { objectKey: string };
    expect(opts.objectKey.startsWith(`workspaces/${TEST_WORKSPACE_ID}/objects/`)).toBe(true);
    expect(opts.objectKey).toContain(idGen.ids[0]); // objectId is in the key.
  });
});
