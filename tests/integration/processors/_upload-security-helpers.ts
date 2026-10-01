import type { StorageProviderAdapter } from '../../../src/infra/providers/types';
import { createCreateUploadHandler } from '../../../src/actions/handlers/uploads/create';
import { createCompleteUploadHandler } from '../../../src/actions/handlers/uploads/complete';
import { enqueueProcessingForObject } from '../../../src/actions/handlers/processing/enqueue';
import { ProcessingWorker } from '../../../src/actions/handlers/processing/worker';
import { createRunnerDependencies } from '../../../src/infra/processors/runner-dependencies';
import { createS3ProviderObjectIO } from '../../../src/infra/processors/provider-io';
import { FakeObjectStatus, FakeProcessingQueue } from '../../actions/handlers/processing/_fakes';
import { FakeVariantWriter } from '../../actions/handlers/processing/runners/_fakes';
import {
  FakeProviderResolver,
  FakeRepositories,
  makeDeterministicIds,
  makeUserCtx,
  TEST_WORKSPACE_ID,
} from '../../actions/handlers/uploads/_fakes';
import type { MalwareScanResult } from '../../../src/actions/handlers/processing/runners/ports';
import { loadFixture } from './_helpers';
import { createDownloadUrlHandler } from '../../../src/actions/handlers/objects/download-url';
import { createRetryProcessingHandler } from '../../../src/actions/handlers/processing/retry';
import { makeObjectsDeps } from '../../actions/handlers/objects/_fakes';

export async function buildUpload(
  verdict: MalwareScanResult['verdict'] = 'clean',
  realAdapter?: StorageProviderAdapter,
  multipart = false,
) {
  let scannerVerdict = verdict;
  let scannerCalls = 0;
  const repos = new FakeRepositories();
  const provider = new FakeProviderResolver({ providerKind: realAdapter?.providerKind });
  const queue = new FakeProcessingQueue();
  const status = new FakeObjectStatus();
  const variants = new FakeVariantWriter();
  const stored = new Map<string, Uint8Array>();
  const now = () => new Date('2026-09-30T00:00:00Z');
  const ids = makeDeterministicIds();
  provider.adapter.getObjectBytesImpl = async ({ objectKey }) => {
    const bytes = stored.get(objectKey);
    if (!bytes) throw new Error('Fixture object missing');
    return bytes;
  };
  provider.adapter.copyObjectImpl = async ({ sourceObjectKey, destinationObjectKey }) => {
    const bytes = stored.get(sourceObjectKey);
    if (!bytes) throw new Error('Fixture object missing');
    stored.set(destinationObjectKey, bytes.slice());
  };
  provider.adapter.putObjectBytesImpl = async ({ objectKey, body, ifAbsent }) => {
    if (ifAbsent && stored.has(objectKey)) throw new Error('Fixture key collision');
    stored.set(objectKey, body);
    return { byteSize: body.byteLength };
  };
  provider.adapter.headObjectImpl = async ({ objectKey }) => ({
    objectKey,
    contentLength: stored.get(objectKey)?.byteLength ?? 0,
    contentType: 'image/avif',
    etag: 'fixture',
    lastModified: now(),
  });
  if (realAdapter) {
    provider.adapter.createSingleUploadUrlImpl = (o) => realAdapter.createSingleUploadUrl(o);
    provider.adapter.createMultipartUploadImpl = (o) => realAdapter.createMultipartUpload(o);
    provider.adapter.signMultipartPartImpl = (o) => realAdapter.signMultipartPart(o);
    provider.adapter.completeMultipartUploadImpl = (o) => realAdapter.completeMultipartUpload(o);
    provider.adapter.headObjectImpl = (o) => realAdapter.headObject(o);
    provider.adapter.copyObjectImpl = (o) => realAdapter.copyObject(o);
    provider.adapter.deleteObjectImpl = (o) => realAdapter.deleteObject(o);
    provider.adapter.getObjectBytesImpl = (o) => realAdapter.getObjectBytes(o);
    provider.adapter.putObjectBytesImpl = (o) => realAdapter.putObjectBytes(o);
    provider.adapter.createDownloadUrlImpl = (o) => realAdapter.createDownloadUrl(o);
  }
  const deps = {
    multipartThresholdBytes: multipart ? 1 : undefined,
    objects: repos.objects,
    sessions: repos.sessions,
    providers: provider,
    now,
    idFactory: realAdapter ? () => crypto.randomUUID() : ids.next,
    enqueueProcessing: async (input: { objectId: string; workspaceId: string }) => {
      const object = await repos.objects.findByIdForWorkspace(input);
      if (!object) throw new Error('Fixture object missing');
      status.seed(object);
      return (await enqueueProcessingForObject({ queue, status, now }, object)).jobs;
    },
  };
  const fixture = loadFixture('sample.avif');
  // Context represents the authorized gateway actor; production auth/scope
  // checks remain covered by the existing internal-route and gateway suites.
  const upload = await createCreateUploadHandler(deps)(
    {
      operation: 'create',
      filename: 'safe.avif',
      contentType: 'image/avif',
      byteSize: fixture.byteLength,
    },
    makeUserCtx(),
  );
  const object = repos.getObject(upload.objectId);
  if (!object) throw new Error('Fixture object missing');
  stored.set(object.providerObjectKey, fixture);
  const complete = createCompleteUploadHandler(deps);
  const providers = {
    resolveDefaultForWorkspace: (workspaceId: string) =>
      provider.resolveDefaultForWorkspace(workspaceId),
    resolveByProviderIdForWorkspace: async (input: { workspaceId: string; providerId: string }) =>
      input.workspaceId === TEST_WORKSPACE_ID && input.providerId === provider.providerId
        ? provider.resolveDefaultForWorkspace(input.workspaceId)
        : null,
  };
  const { registry } = createRunnerDependencies({
    mode: 'live',
    providerIO: createS3ProviderObjectIO({ providers }),
    variants,
    scanner: {
      scan: async () => {
        scannerCalls += 1;
        return { verdict: scannerVerdict };
      },
    },
  });
  const worker = new ProcessingWorker({
    queue,
    status,
    runners: registry,
    now,
    maxConcurrentPerWorkspace: 4,
    maxAttempts: 1,
    findObject: async ({ objectId, workspaceId }) => {
      const found = status.objects.get(objectId);
      return found?.workspaceId === workspaceId ? found : null;
    },
  });
  const objectDeps = makeObjectsDeps();
  objectDeps.objects.findByIdForWorkspace = async (input) => {
    const object = status.objects.get(input.objectId);
    return object?.workspaceId === input.workspaceId
      ? object
      : repos.objects.findByIdForWorkspace(input);
  };
  const download = createDownloadUrlHandler({ ...objectDeps, jobs: queue, providers });
  const retry = createRetryProcessingHandler({ queue, status, objects: objectDeps.objects, now });
  return {
    upload,
    object,
    repos,
    deps,
    fixture,
    scannerCalls: () => scannerCalls,
    complete,
    worker,
    queue,
    status,
    variants,
    stored,
    provider,
    download,
    retry,
    setVerdict: (value: MalwareScanResult['verdict']) => {
      scannerVerdict = value;
    },
  };
}
