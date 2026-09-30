import { describe, expect, test } from 'bun:test';
import { createDownloadUrlHandler } from '../../../../src/actions/handlers/objects/download-url';
import { makeJob, makeObject, makeObjectsDeps, makeUserCtx } from './_fakes';

describe('XYN-SEC-001 signed download quarantine', () => {
  for (const status of ['uploaded', 'processing', 'ready', 'failed'] as const) {
    test.each(['missing', 'queued', 'running', 'failed', 'cancelled'] as const)(
      `object ${status} with scan %s cannot mint a URL`,
      async (scanStatus) => {
        const deps = makeObjectsDeps();
        const object = makeObject({ status });
        deps.objects.seed(object);
        if (scanStatus !== 'missing')
          deps.jobs.seed(
            object.id,
            makeJob({
              objectId: object.id,
              jobType: 'scan_validation',
              required: true,
              status: scanStatus,
            }),
          );
        await expect(
          createDownloadUrlHandler(deps)(
            { operation: 'download_url', objectId: object.id },
            makeUserCtx(),
          ),
        ).rejects.toThrow('Object is not yet available for download');
        expect(deps.providers.resolveByProviderIdCount).toBe(0);
        expect(deps.providers.adapter.calls).toHaveLength(0);
        expect(deps.jobs.lastInput).toEqual({
          objectId: object.id,
          workspaceId: object.workspaceId,
        });
      },
    );
  }
  test('non-required, foreign or conflicting scan evidence cannot authorize a URL', async () => {
    for (const invalid of ['optional', 'foreign', 'conflicting'] as const) {
      const deps = makeObjectsDeps();
      const object = makeObject({ status: 'ready' });
      deps.objects.seed(object);
      const scan = makeJob({
        objectId: invalid === 'foreign' ? 'another-object' : object.id,
        jobType: 'scan_validation',
        required: invalid !== 'optional',
        status: 'succeeded',
      });
      deps.jobs.seed(
        object.id,
        scan,
        ...(invalid === 'conflicting'
          ? [
              makeJob({
                objectId: object.id,
                jobType: 'scan_validation',
                required: true,
                status: 'failed',
              }),
            ]
          : []),
      );
      await expect(
        createDownloadUrlHandler(deps)(
          { operation: 'download_url', objectId: object.id },
          makeUserCtx(),
        ),
      ).rejects.toThrow('Object is not yet available for download');
      expect(deps.providers.adapter.calls).toHaveLength(0);
    }
  });
  test('scan lookup outage prevents signing and uses a closed-set message', async () => {
    const deps = makeObjectsDeps();
    const object = makeObject({ status: 'ready' });
    deps.objects.seed(object);
    deps.jobs.listForObject = async () => {
      throw new Error('fixture internal SQL detail');
    };
    await expect(
      createDownloadUrlHandler(deps)(
        { operation: 'download_url', objectId: object.id },
        makeUserCtx(),
      ),
    ).rejects.toThrow('Object is not yet available for download');
    expect(deps.providers.adapter.calls).toHaveLength(0);
  });
});
