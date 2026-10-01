import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ClamavMalwareScanner } from '../../../src/infra/processors/clamav-scanner';
import { createScanValidationRunner } from '../../../src/actions/handlers/processing/runners/scan-validation';
import {
  seedObject,
  FakeProcessingQueue,
  FakeObjectStatus,
  makeFindObject,
} from '../../actions/handlers/processing/_fakes';
import { ProcessingWorker } from '../../../src/actions/handlers/processing/worker';
import { seedClaimedJob } from '../../actions/handlers/processing/runners/_fakes';

const enabled = process.env.XYNES_ARCHIVE_TEST_PORT !== undefined;
const suite = enabled ? describe : describe.skip;
suite('SEC-002 real pinned archive scanner (low limits)', () => {
  const scanner = new ClamavMalwareScanner({
    host: '127.0.0.1',
    port: Number(process.env.XYNES_ARCHIVE_TEST_PORT ?? 13311),
  });
  const fixture = (name: string) =>
    new Uint8Array(readFileSync(new URL(`../../fixtures/archives/${name}.zip`, import.meta.url)));
  test('accepts an ordinary ZIP', async () => {
    expect(
      await scanner.scan({ bytes: fixture('ordinary'), contentType: 'application/zip' }),
    ).toEqual({ verdict: 'clean' });
  });
  test.each(['member-size', 'expanded-size', 'members', 'nested', 'incomplete'])(
    'quarantines %s without scanner retries',
    async (name) => {
      const bytes = fixture(name);
      expect(await scanner.scan({ bytes })).toEqual({ verdict: 'limit_exceeded' });
      const object = seedObject({ contentType: 'application/zip', byteSize: bytes.byteLength });
      const runner = createScanValidationRunner({
        scanner,
        providerIO: {
          async readObject() {
            return bytes;
          },
          async writeObject() {
            throw new Error('Unexpected variant');
          },
        },
      });
      const result = await runner({
        object,
        job: seedClaimedJob({ jobType: 'scan_validation', required: true }),
      });
      expect(result).toEqual({ errorCode: 'ARCHIVE_INSPECTION_REJECTED', retryable: false });
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
      const worker = new ProcessingWorker({
        queue,
        status,
        findObject: makeFindObject(status),
        runners: { scan_validation: runner },
      });
      const stats = await worker.runOnce();
      expect(stats.failed).toBe(1);
      expect(stats.retried).toBe(0);
      expect(status.objects.get(object.id)?.status).toBe('failed');
      expect((await worker.runOnce()).attempted).toBe(0);
    },
  );
});
