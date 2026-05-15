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
