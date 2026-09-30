import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createStorageDb } from '../../../../src/infra/db/client';
import { PostgresUploadSessionRepository } from '../../../../src/infra/db/repositories/object-and-session-repository';
import { PostgresProcessingJobQueueRepository } from '../../../../src/infra/db/repositories/variant-job-usage-repository';
import { seedWorkspaceFixture } from './_db';
import { createFinalizedSourceKey } from '../../../../src/actions/handlers/uploads/finalized-source';
import { getScanValidationState } from '../../../../src/actions/handlers/processing/scan-gate';
import { toPublicProcessingJob } from '../../../../src/actions/handlers/objects/responses';

const url = process.env.SEC001_ISOLATED_DB_URL;
const suite = url ? describe : describe.skip;

suite('SEC-001-FU-1 isolated Postgres finalization', () => {
  async function fixture() {
    const parsed = new URL(url!);
    if (parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/sec001_fixture')
      throw new Error('Isolated fixture database required');
    const handle = createStorageDb(url, { maxConnections: 4 });
    const fx = await seedWorkspaceFixture(handle.db);
    const repo = new PostgresUploadSessionRepository(handle.db);
    const created = await repo.createObjectWithSession({
      objectId: randomUUID(),
      sessionId: randomUUID(),
      workspaceId: fx.workspaceId,
      providerId: fx.providerId,
      providerObjectKey: `fixture-staging/${randomUUID()}`,
      filename: 'fixture.bin',
      contentType: 'application/octet-stream',
      byteSize: 10,
      sha256: null,
      purpose: 'platform_generic',
      visibility: 'private',
      compressionRequested: false,
      uploadMethod: 'single',
      providerUploadId: null,
      expiresAt: new Date(Date.now() + 60_000),
      createdBy: null,
    });
    const input = {
      sessionId: created.session.id,
      objectId: created.object.id,
      workspaceId: fx.workspaceId,
      stagingObjectKey: created.object.providerObjectKey,
      finalizedObjectKey: createFinalizedSourceKey(created.object),
      sha256: null,
      now: new Date(),
    };
    return {
      repo,
      created,
      input,
      fx,
      handle,
      cleanup: async () => {
        await fx.cleanup();
        await handle.close();
      },
    };
  }

  test('competing transactions publish exactly one source, with both rows committed together', async () => {
    const f = await fixture();
    try {
      const candidate = {
        ...f.input,
        finalizedObjectKey: createFinalizedSourceKey(f.created.object),
      };
      const outcomes = await Promise.all([
        f.repo.finalizeIfPending(f.input),
        f.repo.finalizeIfPending(candidate),
      ]);
      expect(outcomes.filter(Boolean)).toHaveLength(1);
      const accepted = outcomes.find(Boolean)!;
      expect(accepted.object.status).toBe('uploaded');
      expect(accepted.session.status).toBe('completed');
      expect(await f.repo.finalizeIfPending(f.input)).toBeNull();
    } finally {
      await f.cleanup();
    }
  });

  test('foreign workspace, wrong staging key and expiry cannot transition either row', async () => {
    const f = await fixture();
    try {
      for (const bad of [
        { ...f.input, workspaceId: randomUUID() },
        { ...f.input, stagingObjectKey: 'wrong-staging' },
        { ...f.input, now: new Date(Date.now() + 120_000) },
      ])
        expect(await f.repo.finalizeIfPending(bad)).toBeNull();
      expect(
        (
          await f.repo.findByIdForWorkspace({
            sessionId: f.input.sessionId,
            workspaceId: f.fx.workspaceId,
          })
        )?.status,
      ).toBe('pending');
    } finally {
      await f.cleanup();
    }
  });

  test('abort wins the session lock and prevents subsequent finalization', async () => {
    const f = await fixture();
    try {
      expect(
        await f.repo.markAbortedIfPending({
          sessionId: f.input.sessionId,
          workspaceId: f.fx.workspaceId,
          now: new Date(),
        }),
      ).not.toBeNull();
      expect(await f.repo.finalizeIfPending(f.input)).toBeNull();
    } finally {
      await f.cleanup();
    }
  });

  test('a DB write failure rolls back the session and object together', async () => {
    const f = await fixture();
    try {
      await f.repo.createObjectWithSession({
        objectId: randomUUID(),
        sessionId: randomUUID(),
        workspaceId: f.fx.workspaceId,
        providerId: f.fx.providerId,
        providerObjectKey: f.input.finalizedObjectKey,
        filename: 'collision.bin',
        contentType: 'application/octet-stream',
        byteSize: 10,
        sha256: null,
        purpose: 'platform_generic',
        visibility: 'private',
        compressionRequested: false,
        uploadMethod: 'single',
        providerUploadId: null,
        expiresAt: new Date(Date.now() + 60_000),
        createdBy: null,
      });
      await expect(f.repo.finalizeIfPending(f.input)).rejects.toThrow();
      expect(
        (
          await f.repo.findByIdForWorkspace({
            sessionId: f.input.sessionId,
            workspaceId: f.fx.workspaceId,
          })
        )?.status,
      ).toBe('pending');
      // Retry with a fresh candidate succeeds, proving the pending object was retained.
      expect(
        await f.repo.finalizeIfPending({
          ...f.input,
          finalizedObjectKey: createFinalizedSourceKey(f.created.object),
        }),
      ).not.toBeNull();
    } finally {
      await f.cleanup();
    }
  });

  test('successful scan evidence round-trips through real JSONB and stays out of public DTOs', async () => {
    const f = await fixture();
    try {
      const finalized = await f.repo.finalizeIfPending(f.input);
      const queue = new PostgresProcessingJobQueueRepository(f.handle.db);
      await queue.enqueueBatch([
        {
          id: randomUUID(),
          objectId: f.input.objectId,
          workspaceId: f.fx.workspaceId,
          jobType: 'scan_validation',
          required: true,
          payload: { contentType: 'application/octet-stream', byteSize: 10 },
          scheduledAt: new Date(),
        },
      ]);
      const claimed = await queue.claimNextQueuedJob({
        now: new Date(),
        workspaceAllowlist: [f.fx.workspaceId],
      });
      expect(claimed).not.toBeNull();
      await queue.markSucceeded({
        jobId: claimed!.id,
        now: new Date(),
        scanSource: { key: finalized!.object.providerObjectKey, providerId: f.fx.providerId },
      });
      const jobs = await queue.listForObject({
        objectId: f.input.objectId,
        workspaceId: f.fx.workspaceId,
      });
      expect(getScanValidationState(finalized!.object, jobs)).toBe('passed');
      expect(
        getScanValidationState(
          { ...finalized!.object, providerObjectKey: createFinalizedSourceKey(finalized!.object) },
          jobs,
        ),
      ).toBe('blocked');
      expect(JSON.stringify(toPublicProcessingJob(jobs[0]))).not.toContain(
        finalized!.object.providerObjectKey,
      );
    } finally {
      await f.cleanup();
    }
  });
});
