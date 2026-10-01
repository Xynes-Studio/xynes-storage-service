import { describe, expect, test } from 'bun:test';
import { buildUpload } from './_upload-security-helpers';
import { makeUserCtx } from '../../actions/handlers/uploads/_fakes';
import { TEST_WORKSPACE_ID } from '../../actions/handlers/uploads/_fakes';

describe('XYN-SEC-001 upload → fixture provider → queue → live image worker', () => {
  test('an authorized workspace upload produces real variants with patched Sharp', async () => {
    const flow = await buildUpload();
    const result = await flow.complete(
      { operation: 'complete', uploadId: flow.upload.uploadId },
      makeUserCtx(),
    );
    expect(result.processingJobs).toHaveLength(2);
    await expect(
      flow.download({ operation: 'download_url', objectId: flow.upload.objectId }, makeUserCtx()),
    ).rejects.toThrow('Object is not yet available for download');
    expect((await flow.worker.runOnce()).failed).toBe(0);
    expect(flow.status.objects.get(flow.upload.objectId)?.status).toBe('ready');
    expect(flow.variants.records.length).toBeGreaterThan(0);
    for (const record of flow.variants.records) {
      expect(record.workspaceId).toBe(TEST_WORKSPACE_ID);
      expect(record.byteSize).toBeGreaterThan(8);
    }
    expect(
      (
        await flow.download(
          { operation: 'download_url', objectId: flow.upload.objectId },
          makeUserCtx(),
        )
      ).objectId,
    ).toBe(flow.upload.objectId);
  });

  test('a different workspace cannot complete or enqueue the uploaded object', async () => {
    const flow = await buildUpload();
    await expect(
      flow.complete(
        { operation: 'complete', uploadId: flow.upload.uploadId },
        makeUserCtx({ workspaceId: '00000000-0000-4000-8000-000000000009' }),
      ),
    ).rejects.toThrow('Upload session not found');
    expect(flow.queue.enqueueBatchCount).toBe(0);
  });

  test.each(['infected', 'unknown'] as const)(
    'scanner %s cannot mark the parent ready',
    async (verdict) => {
      const flow = await buildUpload(verdict);
      await flow.complete({ operation: 'complete', uploadId: flow.upload.uploadId }, makeUserCtx());
      await flow.worker.runOnce();
      expect(flow.status.objects.get(flow.upload.objectId)?.status).toBe('failed');
      expect(flow.status.calls.some((call) => call.nextStatus === 'ready')).toBe(false);
      expect(
        flow.queue.markFailedCalls.some(
          (call) =>
            call.errorCode ===
            (verdict === 'unknown' ? 'SCANNER_INCONCLUSIVE' : 'MALWARE_DETECTED'),
        ),
      ).toBe(true);
      expect(flow.variants.records).toHaveLength(0);
      expect(
        flow.provider.adapter.calls.filter((call) => call.method === 'putObjectBytes'),
      ).toHaveLength(0);
      await expect(
        flow.download({ operation: 'download_url', objectId: flow.upload.objectId }, makeUserCtx()),
      ).rejects.toThrow('Object is not yet available for download');
      expect(
        flow.provider.adapter.calls.filter((call) => call.method === 'createDownloadUrl'),
      ).toHaveLength(0);
    },
  );

  test('a scanner outage recovers through retry, then permits processing and delivery', async () => {
    const flow = await buildUpload('unknown');
    await flow.complete({ operation: 'complete', uploadId: flow.upload.uploadId }, makeUserCtx());
    await flow.worker.runOnce();
    expect(flow.status.objects.get(flow.upload.objectId)?.status).toBe('failed');
    expect(flow.variants.records).toHaveLength(0);
    flow.setVerdict('clean');
    await flow.retry({ operation: 'retry', objectId: flow.upload.objectId }, makeUserCtx());
    await expect(
      flow.download({ operation: 'download_url', objectId: flow.upload.objectId }, makeUserCtx()),
    ).rejects.toThrow('Object is not yet available for download');
    await flow.worker.runOnce();
    expect(flow.status.objects.get(flow.upload.objectId)?.status).toBe('ready');
    expect(flow.variants.records.length).toBeGreaterThan(0);
    expect(
      (
        await flow.download(
          { operation: 'download_url', objectId: flow.upload.objectId },
          makeUserCtx(),
        )
      ).objectId,
    ).toBe(flow.upload.objectId);
  });
});
