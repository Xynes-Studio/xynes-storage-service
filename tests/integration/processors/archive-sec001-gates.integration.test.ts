/**
 * Combined SEC-001/002 merge gate. Opt in after SEC-001 is available locally.
 * Intentionally fails on the present pre-SEC-001 worker/download implementation.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ClamavMalwareScanner } from '../../../src/infra/processors/clamav-scanner';
import { createScanValidationRunner } from '../../../src/actions/handlers/processing/runners/scan-validation';
import { createImageOptimizeRunner } from '../../../src/actions/handlers/processing/runners/image';
import {
  FakeImageProcessor,
  FakeVariantWriter,
} from '../../actions/handlers/processing/runners/_fakes';
import { ProcessingWorker } from '../../../src/actions/handlers/processing/worker';
import { createDownloadUrlHandler } from '../../../src/actions/handlers/objects/download-url';
import {
  FakeObjectStatus,
  FakeProcessingQueue,
  makeFindObject,
  seedObject,
} from '../../actions/handlers/processing/_fakes';
import {
  ExtendedFakeObjectRepository,
  FakeProcessingJobRepository,
  makeObjectsDeps,
  makeUserCtx,
} from '../../actions/handlers/objects/_fakes';

const required = process.env.XYNES_SEC001_GATES_REQUIRED === '1';
const suite = required ? describe : describe.skip;
suite('SEC-001 + SEC-002 archive quarantine merge gate', () => {
  async function quarantinedArchive(imageClaim = false) {
    expect(process.env.XYNES_ARCHIVE_TEST_PORT).toBeDefined();
    const scanner = new ClamavMalwareScanner({
      host: '127.0.0.1',
      port: Number(process.env.XYNES_ARCHIVE_TEST_PORT),
    });
    const bytes = new Uint8Array(
      readFileSync(new URL('../../fixtures/archives/member-size.zip', import.meta.url)),
    );
    const object = seedObject({
      contentType: imageClaim ? 'image/png' : 'application/zip',
      byteSize: bytes.byteLength,
      status: 'processing',
    });
    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    status.seed(object);
    queue.bindObjectToWorkspace(object.id, object.workspaceId);
    queue.seed({
      id: 'archive-scan',
      objectId: object.id,
      jobType: 'scan_validation',
      required: true,
    });
    let nativeCalls = 0;
    const processor = new FakeImageProcessor();
    processor.probe = async () => {
      nativeCalls++;
      return processor.probeResult;
    };
    const providerIO = {
      async readObject() {
        return bytes;
      },
      async writeObject() {
        throw new Error('Unexpected variant write');
      },
    };
    const worker = new ProcessingWorker({
      queue,
      status,
      findObject: makeFindObject(status),
      runners: {
        scan_validation: createScanValidationRunner({
          scanner,
          providerIO: {
            async readObject() {
              return bytes;
            },
            async writeObject() {
              throw new Error('Unexpected write');
            },
          },
        }),
        image_optimize: createImageOptimizeRunner({
          providerIO,
          processor,
          variants: new FakeVariantWriter(),
        }),
      },
    });
    const stats = await worker.runOnce();
    expect(stats.failed).toBe(1);
    expect(stats.retried).toBe(0);
    expect(queue.getRow('archive-scan')?.errorCode).toBe('ARCHIVE_INSPECTION_REJECTED');
    expect(status.objects.get(object.id)?.status).toBe('failed');
    return { object, queue, status, worker, nativeCalls: () => nativeCalls };
  }
  test('failed real archive inspection blocks signed downloads', async () => {
    const { object, queue, status } = await quarantinedArchive();
    const jobs = new FakeProcessingJobRepository();
    jobs.seed(
      object.id,
      ...(await queue.listForObject({ objectId: object.id, workspaceId: object.workspaceId })),
    );
    const objects = new ExtendedFakeObjectRepository();
    const failed = status.objects.get(object.id);
    if (!failed) throw new Error('Missing failed object');
    objects.seed(failed);
    const deps = makeObjectsDeps({ objects, jobs });
    await expect(
      createDownloadUrlHandler(deps)(
        { operation: 'download_url', objectId: object.id },
        { ...makeUserCtx(), workspaceId: object.workspaceId },
      ),
    ).rejects.toThrow();
    expect(deps.providers.adapter.calls.some((call) => call.method === 'createDownloadUrl')).toBe(
      false,
    );
  });
  test('failed real archive inspection blocks native runners', async () => {
    const { object, queue, worker, nativeCalls } = await quarantinedArchive(true);
    queue.seed({
      id: 'legacy-native',
      objectId: object.id,
      jobType: 'image_optimize',
      required: false,
    });
    await worker.runOnce();
    expect(nativeCalls()).toBe(0);
  });
});
