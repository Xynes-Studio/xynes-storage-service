import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { S3StorageProviderAdapter } from '../../../src/infra/providers/s3-adapter';
import { buildUpload } from './_upload-security-helpers';
import { makeUserCtx } from '../../actions/handlers/uploads/_fakes';

const endpoint = process.env.SEC001_ISOLATED_PROVIDER_URL;
const suite = endpoint ? describe : describe.skip;

suite('SEC-001-FU-1 isolated signed provider flows', () => {
  const bucket = `sec001-fixture-${randomUUID()}`;
  let client: S3Client;
  let adapter: S3StorageProviderAdapter;
  beforeAll(async () => {
    if (new URL(endpoint!).hostname !== '127.0.0.1')
      throw new Error('Loopback fixture provider required');
    const config = {
      providerKind: 'minio' as const,
      endpoint: endpoint!,
      region: 'us-east-1',
      bucket,
      forcePathStyle: true,
      accessKeyId: 'fixture-admin',
      secretAccessKey: 'fixture-only-local-password',
    };
    client = new S3Client({
      endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: config,
    });
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    adapter = new S3StorageProviderAdapter(config);
  });
  afterAll(async () => {
    if (!client) return;
    const objects = await client.send(new ListObjectsV2Command({ Bucket: bucket }));
    if (objects.Contents?.length)
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: objects.Contents.map(({ Key }) => ({ Key })) },
        }),
      );
    await client.send(new DeleteBucketCommand({ Bucket: bucket }));
    client.destroy();
  });

  test.each(['single', 'multipart'] as const)(
    '%s replays cannot mutate scanned bytes, even after a signed GET is issued',
    async (method) => {
      const flow = await buildUpload('clean', adapter, method === 'multipart');
      const putUrl = method === 'single' ? flow.upload.uploadUrl! : flow.upload.parts[0]!.url;
      const put = async (url: string, bytes: Uint8Array) =>
        fetch(url, {
          method: 'PUT',
          body: Buffer.from(bytes),
          headers: method === 'single' ? flow.upload.uploadHeaders : {},
        });
      const landed = await put(putUrl, flow.fixture);
      expect(landed.ok).toBe(true);
      const parts =
        method === 'multipart' ? [{ partNumber: 1, etag: landed.headers.get('etag')! }] : undefined;
      const payload = {
        operation: 'complete',
        uploadId: flow.upload.uploadId,
        ...(parts ? { parts } : {}),
      };
      await flow.complete(payload, makeUserCtx());
      const accepted = flow.repos.getObject(flow.object.id)!;
      expect(await adapter.getObjectBytes({ objectKey: accepted.providerObjectKey })).toEqual(
        flow.fixture,
      );
      const replacement = flow.fixture.slice();
      replacement.fill(0x61);
      // Replacement before scanning/native parsing still addresses staging.
      await put(putUrl, replacement);
      await flow.worker.runOnce();
      expect(flow.scannerCalls()).toBe(1);
      expect(flow.variants.records.length).toBeGreaterThan(0);
      const replay = await put(putUrl, replacement);
      expect(method === 'single' ? replay.ok : !replay.ok).toBe(true);
      const signed = await flow.download(
        { operation: 'download_url', objectId: accepted.id },
        makeUserCtx(),
      );
      // A replay after URL minting still addresses staging or a consumed part ID.
      await put(putUrl, replacement);
      const fetched = await fetch(signed.url);
      expect(fetched.ok).toBe(true);
      expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(Uint8Array.from(flow.fixture));
      const tampered = new URL(putUrl);
      tampered.pathname = tampered.pathname.replace(
        flow.object.providerObjectKey,
        accepted.providerObjectKey,
      );
      expect((await put(tampered.href, replacement)).ok).toBe(false);
      expect(await adapter.getObjectBytes({ objectKey: accepted.providerObjectKey })).toEqual(
        flow.fixture,
      );
      // Completing the same session again never issues another copy or rebinds.
      await flow.complete(payload, makeUserCtx());
      expect(flow.repos.getObject(accepted.id)?.providerObjectKey).toBe(accepted.providerObjectKey);
    },
  );

  test('scanner outage recovery scans the retained snapshot instead of replayed staging', async () => {
    const flow = await buildUpload('unknown', adapter);
    expect(
      (
        await fetch(flow.upload.uploadUrl!, {
          method: 'PUT',
          body: Buffer.from(flow.fixture),
          headers: flow.upload.uploadHeaders,
        })
      ).ok,
    ).toBe(true);
    await flow.complete({ operation: 'complete', uploadId: flow.upload.uploadId }, makeUserCtx());
    await flow.worker.runOnce();
    await expect(
      flow.download({ operation: 'download_url', objectId: flow.object.id }, makeUserCtx()),
    ).rejects.toThrow();
    const replacement = flow.fixture.slice();
    replacement.fill(0x62);
    expect(
      (
        await fetch(flow.upload.uploadUrl!, {
          method: 'PUT',
          body: Buffer.from(replacement),
          headers: flow.upload.uploadHeaders,
        })
      ).ok,
    ).toBe(true);
    flow.setVerdict('clean');
    await flow.retry({ operation: 'retry', objectId: flow.object.id }, makeUserCtx());
    await flow.worker.runOnce();
    const signed = await flow.download(
      { operation: 'download_url', objectId: flow.object.id },
      makeUserCtx(),
    );
    expect(new Uint8Array(await (await fetch(signed.url)).arrayBuffer())).toEqual(
      Uint8Array.from(flow.fixture),
    );
    expect(flow.scannerCalls()).toBe(2);
  });
});
