import { describe, expect, test } from 'bun:test';
import { buildUpload } from './_upload-security-helpers';
import { makeUserCtx } from '../../actions/handlers/uploads/_fakes';
import { getScanValidationState } from '../../../src/actions/handlers/processing/scan-gate';
import { createFinalizedSourceKey } from '../../../src/actions/handlers/uploads/finalized-source';

describe('SEC-001-FU-1 immutable scan source', () => {
  test('same-length replacements before processing, signing and after signing never replace the scanned source', async () => {
    const flow = await buildUpload();
    await flow.complete({ operation: 'complete', uploadId: flow.upload.uploadId }, makeUserCtx());
    const finalized = flow.repos.getObject(flow.upload.objectId)!;
    expect(finalized.providerObjectKey).not.toBe(flow.object.providerObjectKey);
    expect(flow.stored.get(finalized.providerObjectKey)).toEqual(flow.fixture);
    const replacement = flow.fixture.slice();
    replacement.fill(0x61);
    // Scanner and processor run in separate batches/claims.
    const scan = flow.queue.snapshot().find((j) => j.jobType === 'scan_validation')!;
    const native = flow.queue.snapshot().find((j) => j.jobType === 'image_optimize')!;
    flow.queue.seed({ ...native, scheduledAt: new Date('2099-01-01') });
    await flow.worker.runOnce();
    expect(flow.queue.getRow(scan.id)?.status).toBe('succeeded');
    expect(flow.scannerCalls()).toBe(1);
    flow.stored.set(flow.object.providerObjectKey, replacement);
    flow.queue.seed({ ...native, scheduledAt: new Date('2026-09-30') });
    expect((await flow.worker.runOnce()).succeeded).toBe(1);
    expect(flow.variants.records.length).toBeGreaterThan(0);
    const signed = await flow.download(
      { operation: 'download_url', objectId: finalized.id },
      makeUserCtx(),
    );
    expect(signed.url).toContain(finalized.providerObjectKey);
    flow.stored.set(flow.object.providerObjectKey, replacement.slice());
    expect(flow.stored.get(finalized.providerObjectKey)).toEqual(flow.fixture);
    expect(flow.scannerCalls()).toBe(1);
  });

  test('competing completion requests select one immutable source and remain idempotent', async () => {
    const flow = await buildUpload();
    const payload = { operation: 'complete', uploadId: flow.upload.uploadId };
    const results = await Promise.all([
      flow.complete(payload, makeUserCtx()),
      flow.complete(payload, makeUserCtx()),
    ]);
    expect(results.every((r) => r.session.status === 'completed')).toBe(true);
    expect(flow.queue.enqueueBatchCount).toBe(1);
    const accepted = flow.repos.getObject(flow.object.id)!;
    const copies = flow.provider.adapter.calls.filter((c) => c.method === 'copyObject');
    expect(copies).toHaveLength(2);
    expect(flow.stored.get(accepted.providerObjectKey)).toEqual(flow.fixture);
    const before = flow.provider.adapter.calls.length;
    await flow.complete(payload, makeUserCtx());
    expect(flow.provider.adapter.calls).toHaveLength(before);
  });

  test('copy failure leaves the upload pending and creates no scan proof', async () => {
    const flow = await buildUpload();
    flow.provider.adapter.copyObjectImpl = async () => {
      throw new Error('Fixture copy unavailable');
    };
    await expect(
      flow.complete({ operation: 'complete', uploadId: flow.upload.uploadId }, makeUserCtx()),
    ).rejects.toThrow();
    expect(flow.repos.getSession(flow.upload.uploadId)?.status).toBe('pending');
    expect(flow.repos.getObject(flow.object.id)?.providerObjectKey).toBe(
      flow.object.providerObjectKey,
    );
    expect(flow.queue.snapshot()).toHaveLength(0);
  });

  test('expiry during copying cannot finalize or enqueue', async () => {
    const flow = await buildUpload();
    const copy = flow.provider.adapter.copyObjectImpl!;
    flow.provider.adapter.copyObjectImpl = async (opts) => {
      await copy(opts);
      flow.repos.setSessionStatus(flow.upload.uploadId, 'expired');
    };
    await expect(
      flow.complete({ operation: 'complete', uploadId: flow.upload.uploadId }, makeUserCtx()),
    ).rejects.toThrow('no longer pending');
    expect(flow.repos.getObject(flow.object.id)?.status).toBe('pending_upload');
    expect(flow.queue.snapshot()).toHaveLength(0);
  });

  test('legacy, missing and mismatched proof deny both delivery and native processing', async () => {
    for (const invalid of ['legacy', 'missing', 'source', 'provider'] as const) {
      const flow = await buildUpload();
      await flow.complete({ operation: 'complete', uploadId: flow.upload.uploadId }, makeUserCtx());
      await flow.worker.runOnce();
      const object = flow.status.objects.get(flow.object.id)!;
      const scan = flow.queue.snapshot().find((j) => j.jobType === 'scan_validation')!;
      if (invalid === 'legacy')
        flow.status.objects.set(object.id, {
          ...object,
          providerObjectKey: flow.object.providerObjectKey,
        });
      else
        flow.queue.seed({
          ...scan,
          scanSourceKey:
            invalid === 'missing'
              ? null
              : invalid === 'source'
                ? createFinalizedSourceKey(object)
                : object.providerObjectKey,
          scanProviderId:
            invalid === 'provider' ? '00000000-0000-4000-8000-000000000009' : object.providerId,
        });
      const jobs = flow.queue.snapshot();
      expect(getScanValidationState(flow.status.objects.get(object.id)!, jobs)).toBe('blocked');
      await expect(
        flow.download({ operation: 'download_url', objectId: object.id }, makeUserCtx()),
      ).rejects.toThrow('not yet available');
      const priorVariants = flow.variants.records.length;
      flow.queue.seed({ id: 'repeat-native', objectId: object.id, jobType: 'image_optimize' });
      expect((await flow.worker.runOnce()).failed).toBe(1);
      expect(flow.variants.records).toHaveLength(priorVariants);
    }
  });

  test('uncertain DB commit retains its candidate instead of deleting possibly accepted content', async () => {
    const flow = await buildUpload();
    flow.deps.sessions.finalizeIfPending = async () => {
      throw new Error('Fixture DB unavailable');
    };
    await expect(
      flow.complete({ operation: 'complete', uploadId: flow.upload.uploadId }, makeUserCtx()),
    ).rejects.toThrow();
    expect(flow.provider.adapter.calls.some((c) => c.method === 'deleteObject')).toBe(false);
    expect(flow.queue.snapshot()).toHaveLength(0);
  });
});
