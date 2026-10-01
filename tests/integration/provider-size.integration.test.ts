import { describe, expect, test } from 'bun:test';
import { S3StorageProviderAdapter } from '../../src/infra/providers/s3-adapter';
import { createCreateUploadHandler } from '../../src/actions/handlers/uploads/create';
import { createCompleteUploadHandler } from '../../src/actions/handlers/uploads/complete';
import { ValidationError } from '../../src/actions/errors';
import { createS3ProviderObjectIO } from '../../src/infra/processors/provider-io';
import { createImageOptimizeRunner } from '../../src/actions/handlers/processing/runners/image';
import { FakeRepositories, makeDeps, makeUserCtx } from '../actions/handlers/uploads/_fakes';
import {
  FakeImageProcessor,
  FakeVariantWriter,
  seedClaimedJob,
} from '../actions/handlers/processing/runners/_fakes';

/** Loopback S3 protocol fixture: real SDK HTTP, no hosted provider or database. */
describe('XYN-SEC-002 — SDK multipart/HEAD/GET integration', () => {
  for (const [actual, copied] of [
    [3, 3],
    [4, 4],
    [5, 5],
    [4, 5],
  ] as const) {
    test(`multipart declared=4 actual=${actual} copied=${copied}: reconciles before enqueue`, async () => {
      const stored = new Map<string, Uint8Array>();
      const heads: string[] = [];
      const methods: string[] = [];
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
          methods.push(request.method);
          const xml = (body: string) =>
            new Response(body, { headers: { 'content-type': 'application/xml' } });
          if (request.method === 'POST' && url.searchParams.has('uploads')) {
            return xml(
              '<InitiateMultipartUploadResult><Bucket>fixture</Bucket><Key>fixture</Key><UploadId>fixture-upload</UploadId></InitiateMultipartUploadResult>',
            );
          }
          if (request.method === 'PUT' && request.headers.has('x-amz-copy-source')) {
            const source = '/' + decodeURIComponent(request.headers.get('x-amz-copy-source')!);
            // Harmless replay between staging HEAD and copy: change 4 bytes to 5.
            if (copied !== actual) stored.set(source, new Uint8Array(copied));
            stored.set(url.pathname, stored.get(source)!.slice());
            return xml('<CopyObjectResult><ETag>"fixture-etag"</ETag></CopyObjectResult>');
          }
          if (request.method === 'PUT') {
            stored.set(url.pathname, new Uint8Array(await request.arrayBuffer()));
            return new Response(null, { headers: { etag: '"fixture-etag"' } });
          }
          if (request.method === 'POST') {
            await request.text();
            return xml(
              '<CompleteMultipartUploadResult><Bucket>fixture</Bucket><Key>fixture</Key><ETag>"fixture-etag"</ETag></CompleteMultipartUploadResult>',
            );
          }
          if (request.method === 'HEAD') {
            heads.push(url.pathname);
            return new Response(null, {
              headers: { 'content-length': String(stored.get(url.pathname)?.byteLength ?? 0) },
            });
          }
          if (request.method === 'DELETE') {
            stored.delete(url.pathname);
            return new Response(null, { status: 204 });
          }
          // Chunked GET intentionally omits length, testing actual-byte counting.
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(stored.get(url.pathname)!);
                controller.close();
              },
            }),
          );
        },
      });
      try {
        const adapter = new S3StorageProviderAdapter({
          providerKind: 'minio',
          endpoint: `http://127.0.0.1:${server.port}`,
          region: 'us-east-1',
          bucket: 'fixture',
          forcePathStyle: true,
          accessKeyId: 'fixture-access',
          secretAccessKey: 'fixture-secret',
        });
        const repositories = new FakeRepositories();
        const context = makeUserCtx();
        const resolved = {
          adapter,
          providerId: '00000000-0000-4000-8000-0000000000a0',
          providerKind: 'minio' as const,
        };
        const providers = {
          async resolveDefaultForWorkspace() {
            return resolved;
          },
          async resolveByProviderIdForWorkspace() {
            return resolved;
          },
        };
        let enqueued = false;
        const deps = {
          ...makeDeps({ repositories, multipartThresholdBytes: 1 }),
          providers,
          enqueueProcessing: async () => {
            enqueued = true;
            return [];
          },
        };
        const created = await createCreateUploadHandler(deps)(
          { operation: 'create', filename: 'fixture.jpg', contentType: 'image/jpeg', byteSize: 4 },
          context,
        );
        expect(created.uploadMethod).toBe('multipart');
        const part = created.parts[0];
        if (!part) throw new Error('fixture missing upload part');
        expect((await fetch(part.url, { method: 'PUT', body: new Uint8Array(actual) })).ok).toBe(
          true,
        );
        const completed = createCompleteUploadHandler(deps)(
          {
            operation: 'complete',
            uploadId: created.uploadId,
            parts: [{ partNumber: 1, etag: '"fixture-etag"' }],
          },
          context,
        );
        if (actual !== 4 || copied !== 4) {
          await expect(completed).rejects.toBeInstanceOf(ValidationError);
          expect(enqueued).toBe(false);
          if (copied !== actual) {
            expect(heads.at(-1)).toContain('/finalized/v1/');
            expect(repositories.getObject(created.objectId)?.status).toBe('pending_upload');
          }
          expect(
            (
              await repositories.sessions.findByIdForWorkspace({
                sessionId: created.uploadId,
                workspaceId: context.workspaceId,
              })
            )?.status,
          ).toBe('aborted');
        } else {
          expect((await completed).object.status).toBe('uploaded');
          expect(enqueued).toBe(true);
          const object = await repositories.objects.findByIdForWorkspace({
            objectId: created.objectId,
            workspaceId: context.workspaceId,
          });
          if (!object) throw new Error('fixture missing object');
          const providerIO = createS3ProviderObjectIO({ providers });
          expect(
            (
              await providerIO.readObject({
                objectKey: object.providerObjectKey,
                workspaceId: object.workspaceId,
                providerId: object.providerId,
                maxBytes: 4,
                expectedByteSize: 4,
              })
            ).byteLength,
          ).toBe(4);
          // A replaced object must not bypass the worker's streaming guard.
          expect(heads.at(-1)).toBe(`/fixture/${object.providerObjectKey}`);
          stored.set(`/fixture/${object.providerObjectKey}`, new Uint8Array(5));
          let probed = false;
          const processor = new FakeImageProcessor();
          processor.probe = async () => {
            probed = true;
            return processor.probeResult;
          };
          const runner = createImageOptimizeRunner({
            providerIO,
            processor,
            variants: new FakeVariantWriter(),
          });
          expect(await runner({ object, job: seedClaimedJob() })).toEqual({
            errorCode: 'OVER_MAX_BYTES',
            retryable: false,
          });
          expect(probed).toBe(false);
        }
        expect(methods.slice(0, 4)).toEqual(['POST', 'PUT', 'POST', 'HEAD']);
      } finally {
        await server.stop(true);
      }
    });
  }
});
