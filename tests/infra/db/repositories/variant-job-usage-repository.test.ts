/**
 * STORAGE-FU-2 integration tests for variants / processing jobs / usage.
 *
 * These tests live alongside the object+session integration tests and
 * follow the same skip-when-DB-unreachable contract.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { connectOrSkip, seedWorkspaceFixture, seedTwoWorkspaceFixture } from './_db';
import {
  PostgresStorageVariantRepository,
  PostgresStorageProcessingJobRepository,
  PostgresProcessingJobQueueRepository,
  PostgresStorageUsageRepository,
  DuplicateActiveJobError,
} from '../../../../src/infra/db/repositories/variant-job-usage-repository';
import type { IntegrationDb } from './_db';

const ctx: { current: IntegrationDb | null } = { current: null };

beforeAll(async () => {
  ctx.current = await connectOrSkip();
  if (!ctx.current) {
    console.warn('[STORAGE-FU-2] DB unreachable; skipping variant/job/usage integration tests.');
  }
});

afterAll(async () => {
  await ctx.current?.handle.close();
});

function describeIf(label: string, fn: () => void): void {
  describe(label, () => {
    test('precondition: DB reachable', () => {
      if (!ctx.current) {
        expect(ctx.current).toBeNull();
        return;
      }
      expect(ctx.current).not.toBeNull();
    });
    fn();
  });
}

/**
 * Helper to insert an object row directly (no upload session needed
 * for variant + processing job tests).
 */
async function insertObject(
  db: import('../../../../src/infra/db').StorageDb,
  workspaceId: string,
  providerId: string,
  createdBy: string,
  contentType = 'image/png',
): Promise<string> {
  const objectId = randomUUID();
  await db.execute(sql`
    INSERT INTO platform.storage_objects
      (id, workspace_id, provider_id, provider_object_key, filename,
       content_type, byte_size, sha256, purpose, visibility, status,
       compression_requested, created_by, created_at, updated_at,
       uploaded_at)
    VALUES (
      ${objectId}, ${workspaceId}, ${providerId},
      ${`k/${objectId}`}, 'f.png',
      ${contentType}, 1, NULL, 'cms_media', 'private', 'uploaded',
      true, ${createdBy}, now(), now(), now()
    )
  `);
  return objectId;
}

describeIf('PostgresStorageVariantRepository.listForObject', () => {
  test('lists variants for an object scoped to its workspace', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const objectId = await insertObject(ctx.current.db, fx.workspaceId, fx.providerId, fx.userId);
      // Insert two variants.
      const v1 = randomUUID();
      const v2 = randomUUID();
      await ctx.current.db.execute(sql`
        INSERT INTO platform.storage_object_variants
          (id, object_id, variant_kind, provider_object_key, content_type,
           byte_size, status, created_at, ready_at)
        VALUES
          (${v1}, ${objectId}, 'image-1024', ${`k/${objectId}/variants/image-1024.webp`},
           'image/webp', 500, 'ready', now(), now()),
          (${v2}, ${objectId}, 'image-256', ${`k/${objectId}/variants/image-256.webp`},
           'image/webp', 100, 'pending', now(), NULL)
      `);
      const repo = new PostgresStorageVariantRepository(ctx.current.db);
      const variants = await repo.listForObject({
        objectId,
        workspaceId: fx.workspaceId,
      });
      expect(variants.length).toBe(2);
      const keys = variants.map((v) => v.variantKey).sort();
      expect(keys).toEqual(['image-1024', 'image-256']);
      // No leak of provider_object_key.
      const serialised = JSON.stringify(variants);
      expect(serialised).not.toContain('provider_object_key');
      expect(serialised).not.toContain('/variants/image-1024.webp');
    } finally {
      await fx.cleanup();
    }
  });

  test('returns empty array for cross-workspace probes', async () => {
    if (!ctx.current) return;
    const fixtures = await seedTwoWorkspaceFixture(ctx.current.db);
    try {
      const objectId = await insertObject(
        ctx.current.db,
        fixtures.a.workspaceId,
        fixtures.a.providerId,
        fixtures.a.userId,
      );
      await ctx.current.db.execute(sql`
        INSERT INTO platform.storage_object_variants
          (id, object_id, variant_kind, provider_object_key, content_type,
           byte_size, status, created_at, ready_at)
        VALUES (${randomUUID()}, ${objectId}, 'k', 'pk', 'image/webp', 1,
                'ready', now(), now())
      `);
      const repo = new PostgresStorageVariantRepository(ctx.current.db);
      const fromB = await repo.listForObject({
        objectId,
        workspaceId: fixtures.b.workspaceId,
      });
      expect(fromB.length).toBe(0);
    } finally {
      await fixtures.cleanup();
    }
  });
});

describeIf('PostgresStorageProcessingJobRepository.listForObject (read surface)', () => {
  test('lists jobs scoped to workspace + object', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const objectId = await insertObject(ctx.current.db, fx.workspaceId, fx.providerId, fx.userId);
      await ctx.current.db.execute(sql`
        INSERT INTO platform.storage_processing_jobs
          (id, object_id, workspace_id, job_kind, status, attempts,
           scheduled_at, created_at)
        VALUES
          (${randomUUID()}, ${objectId}, ${fx.workspaceId}, 'scan_validation',
           'queued', 0, now(), now()),
          (${randomUUID()}, ${objectId}, ${fx.workspaceId}, 'image_optimize',
           'succeeded', 1, now(), now())
      `);
      const repo = new PostgresStorageProcessingJobRepository(ctx.current.db);
      const jobs = await repo.listForObject({ objectId, workspaceId: fx.workspaceId });
      expect(jobs.length).toBe(2);
      const types = jobs.map((j) => j.jobType).sort();
      expect(types).toEqual(['image_optimize', 'scan_validation']);
      // `required` derived per type.
      const scan = jobs.find((j) => j.jobType === 'scan_validation');
      const opt = jobs.find((j) => j.jobType === 'image_optimize');
      expect(scan!.required).toBe(true);
      expect(opt!.required).toBe(false);
    } finally {
      await fx.cleanup();
    }
  });
});

describeIf('PostgresProcessingJobQueueRepository.enqueueBatch + listForObject', () => {
  test('inserts a batch of queued jobs and round-trips through listForObject', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const objectId = await insertObject(ctx.current.db, fx.workspaceId, fx.providerId, fx.userId);
      const queue = new PostgresProcessingJobQueueRepository(ctx.current.db);
      const now = new Date();
      const inserted = await queue.enqueueBatch([
        {
          id: randomUUID(),
          objectId,
          workspaceId: fx.workspaceId,
          jobType: 'scan_validation',
          required: true,
          payload: {},
          scheduledAt: now,
        },
        {
          id: randomUUID(),
          objectId,
          workspaceId: fx.workspaceId,
          jobType: 'image_optimize',
          required: false,
          payload: {},
          scheduledAt: now,
        },
      ]);
      expect(inserted.length).toBe(2);
      const listed = await queue.listForObject({ objectId, workspaceId: fx.workspaceId });
      expect(listed.length).toBe(2);
    } finally {
      await fx.cleanup();
    }
  });

  test('enqueueBatch is a no-op for an empty input', async () => {
    if (!ctx.current) return;
    const queue = new PostgresProcessingJobQueueRepository(ctx.current.db);
    const out = await queue.enqueueBatch([]);
    expect(out.length).toBe(0);
  });
});

describeIf(
  'PostgresProcessingJobQueueRepository.enqueueBatch — duplicate-job semantics (P1 codex fix)',
  () => {
    test('REJECTS a duplicate (objectId, jobType) with an active row (queued)', async () => {
      if (!ctx.current) return;
      const fx = await seedWorkspaceFixture(ctx.current.db);
      try {
        const objectId = await insertObject(
          ctx.current.db,
          fx.workspaceId,
          fx.providerId,
          fx.userId,
        );
        const queue = new PostgresProcessingJobQueueRepository(ctx.current.db);
        const now = new Date();
        await queue.enqueueBatch([
          {
            id: randomUUID(),
            objectId,
            workspaceId: fx.workspaceId,
            jobType: 'scan_validation',
            required: true,
            payload: {},
            scheduledAt: now,
          },
        ]);
        await expect(
          queue.enqueueBatch([
            {
              id: randomUUID(),
              objectId,
              workspaceId: fx.workspaceId,
              jobType: 'scan_validation',
              required: true,
              payload: {},
              scheduledAt: now,
            },
          ]),
        ).rejects.toThrow(/DUPLICATE_ACTIVE_JOB|already exists/i);
        const all = await queue.listForObject({ objectId, workspaceId: fx.workspaceId });
        const active = all.filter((j) => j.jobType === 'scan_validation' && j.status === 'queued');
        expect(active.length).toBe(1);
      } finally {
        await fx.cleanup();
      }
    });

    test('REJECTS a duplicate when the existing row is `running`', async () => {
      if (!ctx.current) return;
      const fx = await seedWorkspaceFixture(ctx.current.db);
      try {
        const objectId = await insertObject(
          ctx.current.db,
          fx.workspaceId,
          fx.providerId,
          fx.userId,
        );
        const queue = new PostgresProcessingJobQueueRepository(ctx.current.db);
        const past = new Date(Date.now() - 1000);
        await queue.enqueueBatch([
          {
            id: randomUUID(),
            objectId,
            workspaceId: fx.workspaceId,
            jobType: 'image_optimize',
            required: false,
            payload: {},
            scheduledAt: past,
          },
        ]);
        await queue.claimNextQueuedJob({ now: new Date() });
        await expect(
          queue.enqueueBatch([
            {
              id: randomUUID(),
              objectId,
              workspaceId: fx.workspaceId,
              jobType: 'image_optimize',
              required: false,
              payload: {},
              scheduledAt: new Date(),
            },
          ]),
        ).rejects.toThrow(/DUPLICATE_ACTIVE_JOB|already exists/i);
      } finally {
        await fx.cleanup();
      }
    });

    test('ALLOWS a duplicate when prior row is terminally `failed`', async () => {
      if (!ctx.current) return;
      const fx = await seedWorkspaceFixture(ctx.current.db);
      try {
        const objectId = await insertObject(
          ctx.current.db,
          fx.workspaceId,
          fx.providerId,
          fx.userId,
        );
        await ctx.current.db.execute(sql`
          INSERT INTO platform.storage_processing_jobs
            (id, object_id, workspace_id, job_kind, status, attempts,
             scheduled_at, finished_at, error_code, created_at)
          VALUES (${randomUUID()}, ${objectId}, ${fx.workspaceId}, 'image_optimize',
                  'failed', 3, now(), now(), 'PROCESSOR_FAILED', now())
        `);
        const queue = new PostgresProcessingJobQueueRepository(ctx.current.db);
        const inserted = await queue.enqueueBatch([
          {
            id: randomUUID(),
            objectId,
            workspaceId: fx.workspaceId,
            jobType: 'image_optimize',
            required: false,
            payload: {},
            scheduledAt: new Date(),
          },
        ]);
        expect(inserted.length).toBe(1);
        expect(inserted[0].status).toBe('queued');
      } finally {
        await fx.cleanup();
      }
    });

    test('ALLOWS a duplicate when prior row is terminally `succeeded`', async () => {
      if (!ctx.current) return;
      const fx = await seedWorkspaceFixture(ctx.current.db);
      try {
        const objectId = await insertObject(
          ctx.current.db,
          fx.workspaceId,
          fx.providerId,
          fx.userId,
        );
        await ctx.current.db.execute(sql`
          INSERT INTO platform.storage_processing_jobs
            (id, object_id, workspace_id, job_kind, status, attempts,
             scheduled_at, finished_at, created_at)
          VALUES (${randomUUID()}, ${objectId}, ${fx.workspaceId}, 'scan_validation',
                  'succeeded', 1, now(), now(), now())
        `);
        const queue = new PostgresProcessingJobQueueRepository(ctx.current.db);
        const inserted = await queue.enqueueBatch([
          {
            id: randomUUID(),
            objectId,
            workspaceId: fx.workspaceId,
            jobType: 'scan_validation',
            required: true,
            payload: {},
            scheduledAt: new Date(),
          },
        ]);
        expect(inserted.length).toBe(1);
      } finally {
        await fx.cleanup();
      }
    });

    test('rejects a multi-pair batch when ONE pair collides; rolls back the rest', async () => {
      if (!ctx.current) return;
      const fx = await seedWorkspaceFixture(ctx.current.db);
      try {
        const objectId = await insertObject(
          ctx.current.db,
          fx.workspaceId,
          fx.providerId,
          fx.userId,
        );
        const queue = new PostgresProcessingJobQueueRepository(ctx.current.db);
        await queue.enqueueBatch([
          {
            id: randomUUID(),
            objectId,
            workspaceId: fx.workspaceId,
            jobType: 'scan_validation',
            required: true,
            payload: {},
            scheduledAt: new Date(),
          },
        ]);
        await expect(
          queue.enqueueBatch([
            {
              id: randomUUID(),
              objectId,
              workspaceId: fx.workspaceId,
              jobType: 'scan_validation', // collides
              required: true,
              payload: {},
              scheduledAt: new Date(),
            },
            {
              id: randomUUID(),
              objectId,
              workspaceId: fx.workspaceId,
              jobType: 'image_optimize', // fresh
              required: false,
              payload: {},
              scheduledAt: new Date(),
            },
          ]),
        ).rejects.toThrow(/DUPLICATE_ACTIVE_JOB|already exists/i);
        // image_optimize MUST NOT have been inserted (whole-tx rollback).
        const jobs = await queue.listForObject({ objectId, workspaceId: fx.workspaceId });
        expect(jobs.filter((j) => j.jobType === 'image_optimize').length).toBe(0);
      } finally {
        await fx.cleanup();
      }
    });

    test('DuplicateActiveJobError carries objectId + jobType + code + statusHint, and does NOT leak provider config', async () => {
      if (!ctx.current) return;
      const fx = await seedWorkspaceFixture(ctx.current.db);
      try {
        const objectId = await insertObject(
          ctx.current.db,
          fx.workspaceId,
          fx.providerId,
          fx.userId,
        );
        const queue = new PostgresProcessingJobQueueRepository(ctx.current.db);
        await queue.enqueueBatch([
          {
            id: randomUUID(),
            objectId,
            workspaceId: fx.workspaceId,
            jobType: 'scan_validation',
            required: true,
            payload: {},
            scheduledAt: new Date(),
          },
        ]);
        try {
          await queue.enqueueBatch([
            {
              id: randomUUID(),
              objectId,
              workspaceId: fx.workspaceId,
              jobType: 'scan_validation',
              required: true,
              payload: {},
              scheduledAt: new Date(),
            },
          ]);
          throw new Error('expected DuplicateActiveJobError');
        } catch (err) {
          const e = err as DuplicateActiveJobError;
          expect(e.code).toBe('DUPLICATE_ACTIVE_JOB');
          expect(e.statusHint).toBe(409);
          expect(e.objectId).toBe(objectId);
          expect(e.jobType).toBe('scan_validation');
          const msg = String(e.message);
          expect(msg).not.toContain('credential');
          expect(msg).not.toContain('endpoint');
          expect(msg).not.toContain('region');
          expect(msg).not.toContain('bucket');
        }
      } finally {
        await fx.cleanup();
      }
    });
  },
);

describeIf(
  'PostgresProcessingJobQueueRepository.markSucceeded — clears stale errorCode (P2 codex fix)',
  () => {
    test('clears stale errorCode from a previous failed attempt when the retry succeeds', async () => {
      if (!ctx.current) return;
      const fx = await seedWorkspaceFixture(ctx.current.db);
      try {
        const objectId = await insertObject(
          ctx.current.db,
          fx.workspaceId,
          fx.providerId,
          fx.userId,
        );
        const queue = new PostgresProcessingJobQueueRepository(ctx.current.db);
        const jobId = randomUUID();
        await queue.enqueueBatch([
          {
            id: jobId,
            objectId,
            workspaceId: fx.workspaceId,
            jobType: 'image_optimize',
            required: false,
            payload: {},
            scheduledAt: new Date(Date.now() - 1000),
          },
        ]);
        // Attempt 1: claim → fail (retryable).
        await queue.claimNextQueuedJob({ now: new Date() });
        await queue.markFailed({
          jobId,
          errorCode: 'PROCESSOR_FAILED',
          now: new Date(),
          terminal: false,
          nextScheduledAt: new Date(Date.now() - 500),
        });
        // The row is now queued again with a stale errorCode.
        const afterFail = await queue.listForObject({ objectId, workspaceId: fx.workspaceId });
        expect(afterFail[0].errorCode).toBe('PROCESSOR_FAILED');
        // Attempt 2: claim → succeed. markSucceeded MUST clear errorCode.
        await queue.claimNextQueuedJob({ now: new Date() });
        const succeeded = await queue.markSucceeded({ jobId, now: new Date() });
        expect(succeeded!.status).toBe('succeeded');
        expect(succeeded!.errorCode).toBeNull();
        // Re-read via listForObject to prove the stale code is gone for downstream readers.
        const afterSuccess = await queue.listForObject({ objectId, workspaceId: fx.workspaceId });
        expect(afterSuccess[0].errorCode).toBeNull();
      } finally {
        await fx.cleanup();
      }
    });

    test('markSucceeded leaves errorCode = null when the row never failed', async () => {
      if (!ctx.current) return;
      const fx = await seedWorkspaceFixture(ctx.current.db);
      try {
        const objectId = await insertObject(
          ctx.current.db,
          fx.workspaceId,
          fx.providerId,
          fx.userId,
        );
        const queue = new PostgresProcessingJobQueueRepository(ctx.current.db);
        const jobId = randomUUID();
        await queue.enqueueBatch([
          {
            id: jobId,
            objectId,
            workspaceId: fx.workspaceId,
            jobType: 'scan_validation',
            required: true,
            payload: {},
            scheduledAt: new Date(Date.now() - 1000),
          },
        ]);
        await queue.claimNextQueuedJob({ now: new Date() });
        const succeeded = await queue.markSucceeded({ jobId, now: new Date() });
        expect(succeeded!.errorCode).toBeNull();
      } finally {
        await fx.cleanup();
      }
    });
  },
);

describeIf(
  'PostgresProcessingJobQueueRepository.claimNextQueuedJob (FOR UPDATE SKIP LOCKED)',
  () => {
    test('claims one job and flips it to running', async () => {
      if (!ctx.current) return;
      const fx = await seedWorkspaceFixture(ctx.current.db);
      try {
        const objectId = await insertObject(
          ctx.current.db,
          fx.workspaceId,
          fx.providerId,
          fx.userId,
        );
        const queue = new PostgresProcessingJobQueueRepository(ctx.current.db);
        const jobId = randomUUID();
        await queue.enqueueBatch([
          {
            id: jobId,
            objectId,
            workspaceId: fx.workspaceId,
            jobType: 'scan_validation',
            required: true,
            payload: {},
            scheduledAt: new Date(Date.now() - 1000),
          },
        ]);
        const claimed = await queue.claimNextQueuedJob({ now: new Date() });
        expect(claimed).not.toBeNull();
        expect(claimed!.id).toBe(jobId);
        expect(claimed!.jobType).toBe('scan_validation');
        expect(claimed!.required).toBe(true);
        expect(claimed!.maxAttempts).toBe(3); // default from repo
        // Job is now `running` — second claim returns null.
        const second = await queue.claimNextQueuedJob({ now: new Date() });
        expect(second).toBeNull();
      } finally {
        await fx.cleanup();
      }
    });

    test('two concurrent claimers claim different rows (SKIP LOCKED)', async () => {
      if (!ctx.current) return;
      const fx = await seedWorkspaceFixture(ctx.current.db);
      try {
        const objectId = await insertObject(
          ctx.current.db,
          fx.workspaceId,
          fx.providerId,
          fx.userId,
        );
        const queue = new PostgresProcessingJobQueueRepository(ctx.current.db);
        const past = new Date(Date.now() - 1000);
        const id1 = randomUUID();
        const id2 = randomUUID();
        await queue.enqueueBatch([
          {
            id: id1,
            objectId,
            workspaceId: fx.workspaceId,
            jobType: 'scan_validation',
            required: true,
            payload: {},
            scheduledAt: past,
          },
          {
            id: id2,
            objectId,
            workspaceId: fx.workspaceId,
            jobType: 'image_optimize',
            required: false,
            payload: {},
            scheduledAt: past,
          },
        ]);
        // Two concurrent claims via Promise.all — they MUST claim
        // different rows under SKIP LOCKED.
        const [a, b] = await Promise.all([
          queue.claimNextQueuedJob({ now: new Date() }),
          queue.claimNextQueuedJob({ now: new Date() }),
        ]);
        expect(a).not.toBeNull();
        expect(b).not.toBeNull();
        expect(a!.id).not.toBe(b!.id);
      } finally {
        await fx.cleanup();
      }
    });

    test('skips jobs scheduled for the future', async () => {
      if (!ctx.current) return;
      const fx = await seedWorkspaceFixture(ctx.current.db);
      try {
        const objectId = await insertObject(
          ctx.current.db,
          fx.workspaceId,
          fx.providerId,
          fx.userId,
        );
        const queue = new PostgresProcessingJobQueueRepository(ctx.current.db);
        await queue.enqueueBatch([
          {
            id: randomUUID(),
            objectId,
            workspaceId: fx.workspaceId,
            jobType: 'scan_validation',
            required: true,
            payload: {},
            scheduledAt: new Date(Date.now() + 60_000),
          },
        ]);
        const claimed = await queue.claimNextQueuedJob({ now: new Date() });
        expect(claimed).toBeNull();
      } finally {
        await fx.cleanup();
      }
    });

    test('workspaceAllowlist restricts claims to listed workspaces only', async () => {
      if (!ctx.current) return;
      const fixtures = await seedTwoWorkspaceFixture(ctx.current.db);
      try {
        const objA = await insertObject(
          ctx.current.db,
          fixtures.a.workspaceId,
          fixtures.a.providerId,
          fixtures.a.userId,
        );
        const objB = await insertObject(
          ctx.current.db,
          fixtures.b.workspaceId,
          fixtures.b.providerId,
          fixtures.b.userId,
        );
        const queue = new PostgresProcessingJobQueueRepository(ctx.current.db);
        const past = new Date(Date.now() - 1000);
        await queue.enqueueBatch([
          {
            id: randomUUID(),
            objectId: objA,
            workspaceId: fixtures.a.workspaceId,
            jobType: 'scan_validation',
            required: true,
            payload: {},
            scheduledAt: past,
          },
          {
            id: randomUUID(),
            objectId: objB,
            workspaceId: fixtures.b.workspaceId,
            jobType: 'scan_validation',
            required: true,
            payload: {},
            scheduledAt: past,
          },
        ]);
        // Only allow workspace A. Claim MUST yield workspace A's job.
        const claimed = await queue.claimNextQueuedJob({
          now: new Date(),
          workspaceAllowlist: [fixtures.a.workspaceId],
        });
        expect(claimed).not.toBeNull();
        expect(claimed!.workspaceId).toBe(fixtures.a.workspaceId);
      } finally {
        await fixtures.cleanup();
      }
    });
  },
);

describeIf('PostgresProcessingJobQueueRepository.markSucceeded / markFailed / release', () => {
  test('markSucceeded transitions running -> succeeded and bumps attempts', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const objectId = await insertObject(ctx.current.db, fx.workspaceId, fx.providerId, fx.userId);
      const queue = new PostgresProcessingJobQueueRepository(ctx.current.db);
      const jobId = randomUUID();
      await queue.enqueueBatch([
        {
          id: jobId,
          objectId,
          workspaceId: fx.workspaceId,
          jobType: 'scan_validation',
          required: true,
          payload: {},
          scheduledAt: new Date(Date.now() - 1000),
        },
      ]);
      await queue.claimNextQueuedJob({ now: new Date() });
      const done = await queue.markSucceeded({ jobId, now: new Date() });
      expect(done).not.toBeNull();
      expect(done!.status).toBe('succeeded');
      expect(done!.attempts).toBe(1);
    } finally {
      await fx.cleanup();
    }
  });

  test('markFailed terminal=true transitions to failed + records errorCode', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const objectId = await insertObject(ctx.current.db, fx.workspaceId, fx.providerId, fx.userId);
      const queue = new PostgresProcessingJobQueueRepository(ctx.current.db);
      const jobId = randomUUID();
      await queue.enqueueBatch([
        {
          id: jobId,
          objectId,
          workspaceId: fx.workspaceId,
          jobType: 'image_optimize',
          required: false,
          payload: {},
          scheduledAt: new Date(Date.now() - 1000),
        },
      ]);
      await queue.claimNextQueuedJob({ now: new Date() });
      const failed = await queue.markFailed({
        jobId,
        errorCode: 'PROCESSOR_FAILED',
        now: new Date(),
        terminal: true,
      });
      expect(failed!.status).toBe('failed');
      expect(failed!.errorCode).toBe('PROCESSOR_FAILED');
      expect(failed!.attempts).toBe(1);
    } finally {
      await fx.cleanup();
    }
  });

  test('markFailed terminal=false requeues with backoff and bumps attempts', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const objectId = await insertObject(ctx.current.db, fx.workspaceId, fx.providerId, fx.userId);
      const queue = new PostgresProcessingJobQueueRepository(ctx.current.db);
      const jobId = randomUUID();
      await queue.enqueueBatch([
        {
          id: jobId,
          objectId,
          workspaceId: fx.workspaceId,
          jobType: 'image_optimize',
          required: false,
          payload: {},
          scheduledAt: new Date(Date.now() - 1000),
        },
      ]);
      await queue.claimNextQueuedJob({ now: new Date() });
      const nextScheduledAt = new Date(Date.now() + 60_000);
      const out = await queue.markFailed({
        jobId,
        errorCode: 'RUNNER_THREW',
        now: new Date(),
        terminal: false,
        nextScheduledAt,
      });
      expect(out!.status).toBe('queued');
      expect(out!.attempts).toBe(1);
      // Within ~1s of expected because Postgres rounds timestamps.
      const drift = Math.abs(out!.scheduledAt.getTime() - nextScheduledAt.getTime());
      expect(drift).toBeLessThan(2000);
    } finally {
      await fx.cleanup();
    }
  });

  test('markFailed terminal=false without nextScheduledAt throws', async () => {
    if (!ctx.current) return;
    const queue = new PostgresProcessingJobQueueRepository(ctx.current.db);
    await expect(
      queue.markFailed({
        jobId: randomUUID(),
        errorCode: 'X',
        now: new Date(),
        terminal: false,
      }),
    ).rejects.toThrow('nextScheduledAt is required');
  });

  test('releaseClaimedJob requeues WITHOUT bumping attempts', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const objectId = await insertObject(ctx.current.db, fx.workspaceId, fx.providerId, fx.userId);
      const queue = new PostgresProcessingJobQueueRepository(ctx.current.db);
      const jobId = randomUUID();
      await queue.enqueueBatch([
        {
          id: jobId,
          objectId,
          workspaceId: fx.workspaceId,
          jobType: 'image_optimize',
          required: false,
          payload: {},
          scheduledAt: new Date(Date.now() - 1000),
        },
      ]);
      await queue.claimNextQueuedJob({ now: new Date() });
      const released = await queue.releaseClaimedJob({
        jobId,
        nextScheduledAt: new Date(Date.now() + 5_000),
        now: new Date(),
      });
      expect(released!.status).toBe('queued');
      // CRITICAL: attempts NOT incremented.
      expect(released!.attempts).toBe(0);
    } finally {
      await fx.cleanup();
    }
  });

  test('requeueFailedForObject resets terminal failed rows', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const objectId = await insertObject(ctx.current.db, fx.workspaceId, fx.providerId, fx.userId);
      const queue = new PostgresProcessingJobQueueRepository(ctx.current.db);
      const jobId = randomUUID();
      // Insert directly as failed.
      await ctx.current.db.execute(sql`
        INSERT INTO platform.storage_processing_jobs
          (id, object_id, workspace_id, job_kind, status, attempts,
           scheduled_at, finished_at, error_code, error_message, created_at)
        VALUES
          (${jobId}, ${objectId}, ${fx.workspaceId}, 'image_optimize',
           'failed', 3, now(), now(), 'PROCESSOR_FAILED', 'old', now())
      `);
      const out = await queue.requeueFailedForObject({
        objectId,
        workspaceId: fx.workspaceId,
        now: new Date(),
      });
      expect(out.length).toBe(1);
      expect(out[0].status).toBe('queued');
      expect(out[0].attempts).toBe(0);
      expect(out[0].errorCode).toBeNull();
    } finally {
      await fx.cleanup();
    }
  });

  test('requeueFailedForObject does NOT touch running jobs', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const objectId = await insertObject(ctx.current.db, fx.workspaceId, fx.providerId, fx.userId);
      const queue = new PostgresProcessingJobQueueRepository(ctx.current.db);
      const runningId = randomUUID();
      await ctx.current.db.execute(sql`
        INSERT INTO platform.storage_processing_jobs
          (id, object_id, workspace_id, job_kind, status, attempts,
           scheduled_at, started_at, created_at)
        VALUES
          (${runningId}, ${objectId}, ${fx.workspaceId}, 'image_optimize',
           'running', 1, now(), now(), now())
      `);
      const out = await queue.requeueFailedForObject({
        objectId,
        workspaceId: fx.workspaceId,
        now: new Date(),
      });
      // No failed rows to requeue.
      expect(out.length).toBe(0);
      // The running job is still running.
      const running = await queue.listForObject({ objectId, workspaceId: fx.workspaceId });
      expect(running[0].status).toBe('running');
    } finally {
      await fx.cleanup();
    }
  });
});

describeIf('PostgresStorageUsageRepository.readDailyForWorkspace', () => {
  test('reads pre-aggregated daily rows and joins providerKind', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      await ctx.current.db.execute(sql`
        INSERT INTO platform.storage_usage_daily
          (id, workspace_id, provider_id, usage_date, bytes_stored,
           bytes_egress, operations_class_a, operations_class_b,
           object_count, created_at, updated_at)
        VALUES
          (${randomUUID()}, ${fx.workspaceId}, ${fx.providerId}, '2026-05-15',
           1000, 2000, 10, 20, 5, now(), now()),
          (${randomUUID()}, ${fx.workspaceId}, ${fx.providerId}, '2026-05-14',
           500, 1500, 5, 10, 3, now(), now()),
          (${randomUUID()}, ${fx.workspaceId}, NULL, '2026-05-15',
           1500, 3500, 15, 30, 8, now(), now())
      `);
      const repo = new PostgresStorageUsageRepository(ctx.current.db);
      const rows = await repo.readDailyForWorkspace({
        workspaceId: fx.workspaceId,
        fromDate: '2026-05-14',
        toDate: '2026-05-15',
      });
      expect(rows.length).toBe(3);
      const r2rows = rows.filter((r) => r.providerKind === 'r2');
      expect(r2rows.length).toBe(2);
      const aggregate = rows.filter((r) => r.providerKind === null);
      expect(aggregate.length).toBe(1);
    } finally {
      await fx.cleanup();
    }
  });

  test('workspace-scoped: cross-workspace reads return empty', async () => {
    if (!ctx.current) return;
    const fixtures = await seedTwoWorkspaceFixture(ctx.current.db);
    try {
      await ctx.current.db.execute(sql`
        INSERT INTO platform.storage_usage_daily
          (id, workspace_id, provider_id, usage_date, bytes_stored,
           bytes_egress, operations_class_a, operations_class_b,
           object_count, created_at, updated_at)
        VALUES
          (${randomUUID()}, ${fixtures.a.workspaceId}, NULL, '2026-05-15',
           1, 1, 1, 1, 1, now(), now())
      `);
      const repo = new PostgresStorageUsageRepository(ctx.current.db);
      const fromB = await repo.readDailyForWorkspace({
        workspaceId: fixtures.b.workspaceId,
        fromDate: '2026-05-14',
        toDate: '2026-05-15',
      });
      expect(fromB.length).toBe(0);
    } finally {
      await fixtures.cleanup();
    }
  });

  test('inclusive date range', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      await ctx.current.db.execute(sql`
        INSERT INTO platform.storage_usage_daily
          (id, workspace_id, provider_id, usage_date, bytes_stored,
           bytes_egress, operations_class_a, operations_class_b,
           object_count, created_at, updated_at)
        VALUES
          (${randomUUID()}, ${fx.workspaceId}, NULL, '2026-05-10', 1, 1, 1, 1, 1, now(), now()),
          (${randomUUID()}, ${fx.workspaceId}, NULL, '2026-05-15', 1, 1, 1, 1, 1, now(), now()),
          (${randomUUID()}, ${fx.workspaceId}, NULL, '2026-05-20', 1, 1, 1, 1, 1, now(), now())
      `);
      const repo = new PostgresStorageUsageRepository(ctx.current.db);
      const rows = await repo.readDailyForWorkspace({
        workspaceId: fx.workspaceId,
        fromDate: '2026-05-10',
        toDate: '2026-05-15',
      });
      expect(rows.length).toBe(2);
    } finally {
      await fx.cleanup();
    }
  });
});

// ============================================================================
// STORAGE-FU-2-FU-1 — DB-side partial unique index as belt-and-braces
// ============================================================================
describeIf(
  'PostgresProcessingJobQueueRepository.enqueueBatch — STORAGE-FU-2-FU-1 DB-side guard',
  () => {
    test('concurrent enqueueBatch races result in EXACTLY ONE active row + N-1 DuplicateActiveJobError', async () => {
      if (!ctx.current) return;
      const fx = await seedWorkspaceFixture(ctx.current.db);
      try {
        const objectId = await insertObject(
          ctx.current.db,
          fx.workspaceId,
          fx.providerId,
          fx.userId,
        );
        const queue = new PostgresProcessingJobQueueRepository(ctx.current.db);
        const now = new Date();
        const CONCURRENT = 10;
        const promises = Array.from({ length: CONCURRENT }, () =>
          queue.enqueueBatch([
            {
              id: randomUUID(),
              objectId,
              workspaceId: fx.workspaceId,
              jobType: 'scan_validation',
              required: true,
              payload: {},
              scheduledAt: now,
            },
          ]),
        );
        const results = await Promise.allSettled(promises);
        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');
        expect(fulfilled.length).toBe(1);
        expect(rejected.length).toBe(CONCURRENT - 1);
        for (const r of rejected) {
          if (r.status !== 'rejected') continue;
          const err = r.reason as { code?: string; statusHint?: number; name?: string };
          expect(err.code).toBe('DUPLICATE_ACTIVE_JOB');
          expect(err.statusHint).toBe(409);
          expect(err.name).toBe('DuplicateActiveJobError');
        }
        const jobs = await queue.listForObject({
          objectId,
          workspaceId: fx.workspaceId,
        });
        const active = jobs.filter(
          (j) =>
            j.jobType === 'scan_validation' && (j.status === 'queued' || j.status === 'running'),
        );
        expect(active.length).toBe(1);
      } finally {
        await fx.cleanup();
      }
    });

    test('STORAGE-FU-2 pre-check still wins the obvious-case race (one caller, one batch)', async () => {
      if (!ctx.current) return;
      const fx = await seedWorkspaceFixture(ctx.current.db);
      try {
        const objectId = await insertObject(
          ctx.current.db,
          fx.workspaceId,
          fx.providerId,
          fx.userId,
        );
        const queue = new PostgresProcessingJobQueueRepository(ctx.current.db);
        const now = new Date();
        await queue.enqueueBatch([
          {
            id: randomUUID(),
            objectId,
            workspaceId: fx.workspaceId,
            jobType: 'image_optimize',
            required: false,
            payload: {},
            scheduledAt: now,
          },
        ]);
        let caught: Error | null = null;
        try {
          await queue.enqueueBatch([
            {
              id: randomUUID(),
              objectId,
              workspaceId: fx.workspaceId,
              jobType: 'image_optimize',
              required: false,
              payload: {},
              scheduledAt: now,
            },
          ]);
        } catch (err) {
          caught = err as Error;
        }
        expect(caught).not.toBeNull();
        const e = caught as DuplicateActiveJobError;
        expect(e.code).toBe('DUPLICATE_ACTIVE_JOB');
        expect(e.statusHint).toBe(409);
        expect(e.objectId).toBe(objectId);
        expect(e.jobType).toBe('image_optimize');
        const msg = String(e.message);
        expect(msg).not.toContain('credential');
        expect(msg).not.toContain('endpoint');
        expect(msg).not.toContain('region');
        expect(msg).not.toContain('bucket');
      } finally {
        await fx.cleanup();
      }
    });

    test('retries after a TERMINAL row still land (partial predicate excludes terminal status)', async () => {
      if (!ctx.current) return;
      const fx = await seedWorkspaceFixture(ctx.current.db);
      try {
        const objectId = await insertObject(
          ctx.current.db,
          fx.workspaceId,
          fx.providerId,
          fx.userId,
        );
        await ctx.current.db.execute(sql`
          INSERT INTO platform.storage_processing_jobs
            (id, object_id, workspace_id, job_kind, status, attempts,
             scheduled_at, finished_at, error_code, created_at)
          VALUES (${randomUUID()}, ${objectId}, ${fx.workspaceId}, 'image_optimize',
                  'failed', 3, now(), now(), 'PROCESSOR_FAILED', now())
        `);
        const queue = new PostgresProcessingJobQueueRepository(ctx.current.db);
        const inserted = await queue.enqueueBatch([
          {
            id: randomUUID(),
            objectId,
            workspaceId: fx.workspaceId,
            jobType: 'image_optimize',
            required: false,
            payload: {},
            scheduledAt: new Date(),
          },
        ]);
        expect(inserted.length).toBe(1);
        const jobs = await queue.listForObject({
          objectId,
          workspaceId: fx.workspaceId,
        });
        const filtered = jobs.filter((j) => j.jobType === 'image_optimize');
        expect(filtered.length).toBe(2);
        const byStatus = filtered.map((j) => j.status).sort();
        expect(byStatus).toEqual(['failed', 'queued']);
      } finally {
        await fx.cleanup();
      }
    });

    test('the FU-1 partial unique index exists with the documented predicate (DB-side invariant)', async () => {
      if (!ctx.current) return;
      const rows = (await ctx.current.db.execute(sql`
        SELECT indexdef
          FROM pg_indexes
         WHERE schemaname = 'platform'
           AND indexname = 'storage_processing_jobs_active_unique_uidx'
      `)) as unknown as Array<{ indexdef: string }>;
      expect(rows.length).toBe(1);
      const def = rows[0].indexdef;
      expect(def).toContain('UNIQUE');
      expect(def).toContain('platform.storage_processing_jobs');
      expect(def).toContain('btree (object_id, job_kind)');
      // Postgres normalises `status IN (...)` to `status = ANY (ARRAY[...])`.
      expect(def).toMatch(/status\s*=\s*ANY\s*\(ARRAY\[/);
      expect(def).toContain("'queued'");
      expect(def).toContain("'running'");
      // The predicate MUST exclude every terminal status.
      expect(def).not.toContain("'succeeded'");
      expect(def).not.toContain("'failed'");
      expect(def).not.toContain("'cancelled'");
    });

    test('errors unrelated to the FU-1 index propagate unchanged (FK violation regression guard)', async () => {
      if (!ctx.current) return;
      const fx = await seedWorkspaceFixture(ctx.current.db);
      try {
        const objectId = await insertObject(
          ctx.current.db,
          fx.workspaceId,
          fx.providerId,
          fx.userId,
        );
        const queue = new PostgresProcessingJobQueueRepository(ctx.current.db);
        let caught: Error | null = null;
        try {
          await queue.enqueueBatch([
            {
              id: randomUUID(),
              objectId,
              workspaceId: '00000000-0000-0000-0000-000000000000', // FK miss
              jobType: 'scan_validation',
              required: true,
              payload: {},
              scheduledAt: new Date(),
            },
          ]);
        } catch (err) {
          caught = err as Error;
        }
        expect(caught).not.toBeNull();
        const code = (caught as { code?: string }).code;
        // MUST NOT be a `DuplicateActiveJobError` — this is a FK
        // violation, not a duplicate. The repo's FU-1 catch must only
        // translate the unique-violation on the FU-1 index.
        expect(code).not.toBe('DUPLICATE_ACTIVE_JOB');
      } finally {
        await fx.cleanup();
      }
    });
  },
);
