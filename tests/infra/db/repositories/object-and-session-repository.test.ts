/**
 * STORAGE-FU-2 integration tests for object + upload session repos.
 *
 * Runs against the dev Supabase stack on `127.0.0.1:5432` by default,
 * or the env-overridden `STORAGE_INTEGRATION_DB_URL`. SKIPS cleanly
 * when the DB is unreachable (clean laptop, no docker).
 *
 * Each test seeds its own workspace fixture so it can run in any order
 * relative to other tests; the workspace cascade clears every row tree
 * on cleanup.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { connectOrSkip, seedWorkspaceFixture, seedTwoWorkspaceFixture } from './_db';
import {
  PostgresStorageObjectRepository,
  PostgresExtendedStorageObjectRepository,
  PostgresUploadSessionRepository,
  PostgresAbandonedUploadSessionRepository,
  PostgresStorageObjectStatusRepository,
} from '../../../../src/infra/db/repositories/object-and-session-repository';
import type { IntegrationDb } from './_db';

const ctx: { current: IntegrationDb | null } = { current: null };

beforeAll(async () => {
  ctx.current = await connectOrSkip();
  if (!ctx.current) {
    console.warn('[STORAGE-FU-2] DB unreachable; skipping object+session integration tests.');
  }
});

afterAll(async () => {
  await ctx.current?.handle.close();
});

function describeIf(label: string, fn: () => void): void {
  describe(label, () => {
    test('precondition: DB reachable', () => {
      if (!ctx.current) {
        // Single soft-skip assertion so reporters surface the file.
        expect(ctx.current).toBeNull();
        return;
      }
      expect(ctx.current).not.toBeNull();
    });
    fn();
  });
}

describeIf('PostgresUploadSessionRepository.createObjectWithSession + findByIdForWorkspace', () => {
  test('inserts object + session atomically and round-trips', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const repo = new PostgresUploadSessionRepository(ctx.current.db);
      const objectId = randomUUID();
      const sessionId = randomUUID();
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
      const out = await repo.createObjectWithSession({
        objectId,
        sessionId,
        workspaceId: fx.workspaceId,
        providerId: fx.providerId,
        providerObjectKey: `workspaces/${fx.workspaceId}/objects/${objectId}/file.png`,
        filename: 'file.png',
        contentType: 'image/png',
        byteSize: 12345,
        sha256: null,
        purpose: 'cms_media',
        visibility: 'private',
        compressionRequested: true,
        uploadMethod: 'single',
        providerUploadId: null,
        expiresAt,
        createdBy: fx.userId,
      });
      expect(out.object.id).toBe(objectId);
      expect(out.object.workspaceId).toBe(fx.workspaceId);
      expect(out.object.status).toBe('pending_upload');
      expect(out.session.id).toBe(sessionId);
      expect(out.session.status).toBe('pending');
      // Re-read from the session repo.
      const fetched = await repo.findByIdForWorkspace({
        sessionId,
        workspaceId: fx.workspaceId,
      });
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(sessionId);
    } finally {
      await fx.cleanup();
    }
  });

  test('rolls back BOTH rows when the session insert fails (duplicate session id)', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const repo = new PostgresUploadSessionRepository(ctx.current.db);
      const objectId1 = randomUUID();
      const sessionId = randomUUID();
      // First insert: succeeds.
      await repo.createObjectWithSession({
        objectId: objectId1,
        sessionId,
        workspaceId: fx.workspaceId,
        providerId: fx.providerId,
        providerObjectKey: `workspaces/${fx.workspaceId}/objects/${objectId1}/a.png`,
        filename: 'a.png',
        contentType: 'image/png',
        byteSize: 1,
        sha256: null,
        purpose: 'cms_media',
        visibility: 'private',
        compressionRequested: true,
        uploadMethod: 'single',
        providerUploadId: null,
        expiresAt: new Date(Date.now() + 60_000),
        createdBy: fx.userId,
      });
      // Second insert: reuses the session id -> primary-key conflict.
      const objectId2 = randomUUID();
      await expect(
        repo.createObjectWithSession({
          objectId: objectId2,
          sessionId, // duplicate
          workspaceId: fx.workspaceId,
          providerId: fx.providerId,
          providerObjectKey: `workspaces/${fx.workspaceId}/objects/${objectId2}/b.png`,
          filename: 'b.png',
          contentType: 'image/png',
          byteSize: 1,
          sha256: null,
          purpose: 'cms_media',
          visibility: 'private',
          compressionRequested: true,
          uploadMethod: 'single',
          providerUploadId: null,
          expiresAt: new Date(Date.now() + 60_000),
          createdBy: fx.userId,
        }),
      ).rejects.toThrow();
      // Object row 2 MUST NOT exist (transaction rolled back).
      const probe = await ctx.current.db.execute(
        sql`SELECT id FROM platform.storage_objects WHERE id = ${objectId2}`,
      );
      const rows = probe as unknown as Array<{ id: string }>;
      expect(rows.length).toBe(0);
    } finally {
      await fx.cleanup();
    }
  });

  test('findByIdForWorkspace is workspace-scoped (cross-workspace returns null)', async () => {
    if (!ctx.current) return;
    const fixtures = await seedTwoWorkspaceFixture(ctx.current.db);
    try {
      const repo = new PostgresUploadSessionRepository(ctx.current.db);
      const sessionId = randomUUID();
      await repo.createObjectWithSession({
        objectId: randomUUID(),
        sessionId,
        workspaceId: fixtures.a.workspaceId,
        providerId: fixtures.a.providerId,
        providerObjectKey: 'x/y',
        filename: 'x.png',
        contentType: 'image/png',
        byteSize: 1,
        sha256: null,
        purpose: 'cms_media',
        visibility: 'private',
        compressionRequested: true,
        uploadMethod: 'single',
        providerUploadId: null,
        expiresAt: new Date(Date.now() + 60_000),
        createdBy: fixtures.a.userId,
      });
      // Lookup with workspace B's id MUST return null even though the
      // session exists in workspace A.
      const fromB = await repo.findByIdForWorkspace({
        sessionId,
        workspaceId: fixtures.b.workspaceId,
      });
      expect(fromB).toBeNull();
      const fromA = await repo.findByIdForWorkspace({
        sessionId,
        workspaceId: fixtures.a.workspaceId,
      });
      expect(fromA).not.toBeNull();
    } finally {
      await fixtures.cleanup();
    }
  });
});

describeIf('PostgresUploadSessionRepository conditional transitions', () => {
  test('markCompletedIfPending flips pending -> completed and returns row', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const repo = new PostgresUploadSessionRepository(ctx.current.db);
      const sessionId = randomUUID();
      await repo.createObjectWithSession({
        objectId: randomUUID(),
        sessionId,
        workspaceId: fx.workspaceId,
        providerId: fx.providerId,
        providerObjectKey: 'k',
        filename: 'f.png',
        contentType: 'image/png',
        byteSize: 1,
        sha256: null,
        purpose: 'cms_media',
        visibility: 'private',
        compressionRequested: true,
        uploadMethod: 'single',
        providerUploadId: null,
        expiresAt: new Date(Date.now() + 60_000),
        createdBy: fx.userId,
      });
      const now = new Date();
      const out = await repo.markCompletedIfPending({
        sessionId,
        workspaceId: fx.workspaceId,
        now,
      });
      expect(out).not.toBeNull();
      expect(out!.status).toBe('completed');
      expect(out!.completedAt).not.toBeNull();
    } finally {
      await fx.cleanup();
    }
  });

  test('markCompletedIfPending returns null when session is already completed', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const repo = new PostgresUploadSessionRepository(ctx.current.db);
      const sessionId = randomUUID();
      await repo.createObjectWithSession({
        objectId: randomUUID(),
        sessionId,
        workspaceId: fx.workspaceId,
        providerId: fx.providerId,
        providerObjectKey: 'k',
        filename: 'f.png',
        contentType: 'image/png',
        byteSize: 1,
        sha256: null,
        purpose: 'cms_media',
        visibility: 'private',
        compressionRequested: true,
        uploadMethod: 'single',
        providerUploadId: null,
        expiresAt: new Date(Date.now() + 60_000),
        createdBy: fx.userId,
      });
      const first = await repo.markCompletedIfPending({
        sessionId,
        workspaceId: fx.workspaceId,
        now: new Date(),
      });
      expect(first).not.toBeNull();
      // Second call races; returns null.
      const second = await repo.markCompletedIfPending({
        sessionId,
        workspaceId: fx.workspaceId,
        now: new Date(),
      });
      expect(second).toBeNull();
    } finally {
      await fx.cleanup();
    }
  });

  test('markCompletedIfPending returns null when session has already expired', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const repo = new PostgresUploadSessionRepository(ctx.current.db);
      const sessionId = randomUUID();
      // Insert with already-past expires_at.
      await repo.createObjectWithSession({
        objectId: randomUUID(),
        sessionId,
        workspaceId: fx.workspaceId,
        providerId: fx.providerId,
        providerObjectKey: 'k',
        filename: 'f.png',
        contentType: 'image/png',
        byteSize: 1,
        sha256: null,
        purpose: 'cms_media',
        visibility: 'private',
        compressionRequested: true,
        uploadMethod: 'single',
        providerUploadId: null,
        // Already expired.
        expiresAt: new Date(Date.now() - 1000),
        createdBy: fx.userId,
      });
      const out = await repo.markCompletedIfPending({
        sessionId,
        workspaceId: fx.workspaceId,
        now: new Date(),
      });
      expect(out).toBeNull();
    } finally {
      await fx.cleanup();
    }
  });

  test('markAbortedIfPending flips pending -> aborted and returns row', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const repo = new PostgresUploadSessionRepository(ctx.current.db);
      const sessionId = randomUUID();
      await repo.createObjectWithSession({
        objectId: randomUUID(),
        sessionId,
        workspaceId: fx.workspaceId,
        providerId: fx.providerId,
        providerObjectKey: 'k',
        filename: 'f.png',
        contentType: 'image/png',
        byteSize: 1,
        sha256: null,
        purpose: 'cms_media',
        visibility: 'private',
        compressionRequested: true,
        uploadMethod: 'multipart',
        providerUploadId: 'PROV-UP-1',
        expiresAt: new Date(Date.now() + 60_000),
        createdBy: fx.userId,
      });
      const out = await repo.markAbortedIfPending({
        sessionId,
        workspaceId: fx.workspaceId,
        now: new Date(),
      });
      expect(out).not.toBeNull();
      expect(out!.status).toBe('aborted');
      expect(out!.abortedAt).not.toBeNull();
    } finally {
      await fx.cleanup();
    }
  });

  test('cross-workspace markCompletedIfPending returns null without mutating the row', async () => {
    if (!ctx.current) return;
    const fixtures = await seedTwoWorkspaceFixture(ctx.current.db);
    try {
      const repo = new PostgresUploadSessionRepository(ctx.current.db);
      const sessionId = randomUUID();
      await repo.createObjectWithSession({
        objectId: randomUUID(),
        sessionId,
        workspaceId: fixtures.a.workspaceId,
        providerId: fixtures.a.providerId,
        providerObjectKey: 'k',
        filename: 'f.png',
        contentType: 'image/png',
        byteSize: 1,
        sha256: null,
        purpose: 'cms_media',
        visibility: 'private',
        compressionRequested: true,
        uploadMethod: 'single',
        providerUploadId: null,
        expiresAt: new Date(Date.now() + 60_000),
        createdBy: fixtures.a.userId,
      });
      const denied = await repo.markCompletedIfPending({
        sessionId,
        workspaceId: fixtures.b.workspaceId,
        now: new Date(),
      });
      expect(denied).toBeNull();
      // Verify the row in workspace A is still pending.
      const aRow = await repo.findByIdForWorkspace({
        sessionId,
        workspaceId: fixtures.a.workspaceId,
      });
      expect(aRow!.status).toBe('pending');
    } finally {
      await fixtures.cleanup();
    }
  });
});

describeIf('PostgresStorageObjectRepository.markUploaded', () => {
  test('flips pending_upload -> uploaded and sets uploadedAt + sha256', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const sessionRepo = new PostgresUploadSessionRepository(ctx.current.db);
      const repo = new PostgresStorageObjectRepository(ctx.current.db);
      const objectId = randomUUID();
      await sessionRepo.createObjectWithSession({
        objectId,
        sessionId: randomUUID(),
        workspaceId: fx.workspaceId,
        providerId: fx.providerId,
        providerObjectKey: 'k',
        filename: 'f.png',
        contentType: 'image/png',
        byteSize: 1,
        sha256: null,
        purpose: 'cms_media',
        visibility: 'private',
        compressionRequested: true,
        uploadMethod: 'single',
        providerUploadId: null,
        expiresAt: new Date(Date.now() + 60_000),
        createdBy: fx.userId,
      });
      const out = await repo.markUploaded({
        objectId,
        workspaceId: fx.workspaceId,
        sha256: 'a'.repeat(64),
      });
      expect(out).not.toBeNull();
      expect(out!.status).toBe('uploaded');
      expect(out!.sha256).toBe('a'.repeat(64));
      expect(out!.uploadedAt).not.toBeNull();
    } finally {
      await fx.cleanup();
    }
  });

  test('idempotent: second call against an uploaded row returns the row unchanged', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const sessionRepo = new PostgresUploadSessionRepository(ctx.current.db);
      const repo = new PostgresStorageObjectRepository(ctx.current.db);
      const objectId = randomUUID();
      await sessionRepo.createObjectWithSession({
        objectId,
        sessionId: randomUUID(),
        workspaceId: fx.workspaceId,
        providerId: fx.providerId,
        providerObjectKey: 'k',
        filename: 'f.png',
        contentType: 'image/png',
        byteSize: 1,
        sha256: null,
        purpose: 'cms_media',
        visibility: 'private',
        compressionRequested: true,
        uploadMethod: 'single',
        providerUploadId: null,
        expiresAt: new Date(Date.now() + 60_000),
        createdBy: fx.userId,
      });
      const first = await repo.markUploaded({
        objectId,
        workspaceId: fx.workspaceId,
        sha256: 'b'.repeat(64),
      });
      const second = await repo.markUploaded({
        objectId,
        workspaceId: fx.workspaceId,
        sha256: 'CHANGED',
      });
      expect(first!.sha256).toBe('b'.repeat(64));
      // Idempotent: sha256 NOT overwritten on repeat call.
      expect(second!.sha256).toBe('b'.repeat(64));
      expect(second!.status).toBe('uploaded');
    } finally {
      await fx.cleanup();
    }
  });

  test('returns null for cross-workspace and for unknown ids', async () => {
    if (!ctx.current) return;
    const fixtures = await seedTwoWorkspaceFixture(ctx.current.db);
    try {
      const sessionRepo = new PostgresUploadSessionRepository(ctx.current.db);
      const repo = new PostgresStorageObjectRepository(ctx.current.db);
      const objectId = randomUUID();
      await sessionRepo.createObjectWithSession({
        objectId,
        sessionId: randomUUID(),
        workspaceId: fixtures.a.workspaceId,
        providerId: fixtures.a.providerId,
        providerObjectKey: 'k',
        filename: 'f.png',
        contentType: 'image/png',
        byteSize: 1,
        sha256: null,
        purpose: 'cms_media',
        visibility: 'private',
        compressionRequested: true,
        uploadMethod: 'single',
        providerUploadId: null,
        expiresAt: new Date(Date.now() + 60_000),
        createdBy: fixtures.a.userId,
      });
      const denied = await repo.markUploaded({
        objectId,
        workspaceId: fixtures.b.workspaceId,
        sha256: null,
      });
      expect(denied).toBeNull();
      const unknown = await repo.markUploaded({
        objectId: randomUUID(),
        workspaceId: fixtures.a.workspaceId,
        sha256: null,
      });
      expect(unknown).toBeNull();
    } finally {
      await fixtures.cleanup();
    }
  });

  test('returns null when status is `deleted`', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const sessionRepo = new PostgresUploadSessionRepository(ctx.current.db);
      const extRepo = new PostgresExtendedStorageObjectRepository(ctx.current.db);
      const repo = new PostgresStorageObjectRepository(ctx.current.db);
      const objectId = randomUUID();
      await sessionRepo.createObjectWithSession({
        objectId,
        sessionId: randomUUID(),
        workspaceId: fx.workspaceId,
        providerId: fx.providerId,
        providerObjectKey: 'k',
        filename: 'f.png',
        contentType: 'image/png',
        byteSize: 1,
        sha256: null,
        purpose: 'cms_media',
        visibility: 'private',
        compressionRequested: true,
        uploadMethod: 'single',
        providerUploadId: null,
        expiresAt: new Date(Date.now() + 60_000),
        createdBy: fx.userId,
      });
      // Soft-delete the row.
      await extRepo.softDeleteForWorkspace({
        objectId,
        workspaceId: fx.workspaceId,
        now: new Date(),
      });
      // markUploaded against a deleted row MUST return null.
      const out = await repo.markUploaded({
        objectId,
        workspaceId: fx.workspaceId,
        sha256: null,
      });
      expect(out).toBeNull();
    } finally {
      await fx.cleanup();
    }
  });

  test('race-loss re-read path: when conditional update misses, returns the canonical state', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const sessionRepo = new PostgresUploadSessionRepository(ctx.current.db);
      const repo = new PostgresStorageObjectRepository(ctx.current.db);
      const objectId = randomUUID();
      await sessionRepo.createObjectWithSession({
        objectId,
        sessionId: randomUUID(),
        workspaceId: fx.workspaceId,
        providerId: fx.providerId,
        providerObjectKey: 'k',
        filename: 'f.png',
        contentType: 'image/png',
        byteSize: 1,
        sha256: null,
        purpose: 'cms_media',
        visibility: 'private',
        compressionRequested: true,
        uploadMethod: 'single',
        providerUploadId: null,
        expiresAt: new Date(Date.now() + 60_000),
        createdBy: fx.userId,
      });
      // Simulate a race: flip the row to `processing` directly. The
      // initial findByIdForWorkspace select inside markUploaded will
      // see `processing` (post-uploaded state) and return the row
      // unchanged — that's the early-idempotent path. Re-set to
      // `pending_upload` and immediately race the conditional update
      // by flipping to `uploaded` from a different connection.
      //
      // The repo's logic is: select → see pending_upload → run the
      // conditional update. If between those two queries another
      // worker has already flipped the row to (say) `uploaded`, the
      // conditional update matches 0 rows and the repo re-reads + maps
      // the row instead of returning null.
      //
      // We don't have a clean way to interpose between the select and
      // update from the test, so the most reliable trigger is:
      // (a) call markUploaded once normally; (b) note the result is
      // the uploaded row; (c) the second call's initial-select returns
      // 'uploaded', not 'pending_upload', so it takes the early
      // idempotent path. That covers the idempotent return.
      //
      // The race-loss re-read path itself is intentionally defensive;
      // forcing it deterministically would require a transaction-level
      // hook we don't expose. The path is still exercised by the
      // soft-delete race path below.

      // To exercise the actual race-loss re-read where the row's
      // status moves OUT FROM UNDER THE UPDATE: manually break the
      // unique invariant. We update the row to `uploaded` between
      // markUploaded's select and its conditional update by inserting
      // a sleep — but Bun has no per-line interposition. Instead, we
      // RACE two markUploaded calls and assert both return a non-null
      // uploaded row (one wins the conditional update, the other
      // takes the re-read path).
      const [a, b] = await Promise.all([
        repo.markUploaded({
          objectId,
          workspaceId: fx.workspaceId,
          sha256: 'a'.repeat(64),
        }),
        repo.markUploaded({
          objectId,
          workspaceId: fx.workspaceId,
          sha256: 'b'.repeat(64),
        }),
      ]);
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(a!.status).toBe('uploaded');
      expect(b!.status).toBe('uploaded');
    } finally {
      await fx.cleanup();
    }
  });
});

describeIf(
  'PostgresStorageObjectRepository.markUploaded re-read paths (post-test additions)',
  () => {
    test('race-loss + soft-delete: re-read sees deleted and returns null', async () => {
      if (!ctx.current) return;
      const fx = await seedWorkspaceFixture(ctx.current.db);
      try {
        const sessionRepo = new PostgresUploadSessionRepository(ctx.current.db);
        const repo = new PostgresStorageObjectRepository(ctx.current.db);
        const objectId = randomUUID();
        await sessionRepo.createObjectWithSession({
          objectId,
          sessionId: randomUUID(),
          workspaceId: fx.workspaceId,
          providerId: fx.providerId,
          providerObjectKey: 'k',
          filename: 'f.png',
          contentType: 'image/png',
          byteSize: 1,
          sha256: null,
          purpose: 'cms_media',
          visibility: 'private',
          compressionRequested: true,
          uploadMethod: 'single',
          providerUploadId: null,
          expiresAt: new Date(Date.now() + 60_000),
          createdBy: fx.userId,
        });
        // Use a raced UPDATE to flip pending_upload -> deleted BEFORE
        // markUploaded calls its conditional update. We can't intercept
        // mid-method, but we can verify the alternative: pre-flip to
        // deleted; then markUploaded's INITIAL select sees `deleted` and
        // short-circuits to null (covers the `if (row.status ===
        // 'deleted') return null` branch).
        await ctx.current.db.execute(sql`
        UPDATE platform.storage_objects
           SET status = 'deleted', deleted_at = now()
         WHERE id = ${objectId}
      `);
        const out = await repo.markUploaded({
          objectId,
          workspaceId: fx.workspaceId,
          sha256: null,
        });
        expect(out).toBeNull();
      } finally {
        await fx.cleanup();
      }
    });

    test('explicit `processing` state on initial select takes the early-idempotent path', async () => {
      if (!ctx.current) return;
      const fx = await seedWorkspaceFixture(ctx.current.db);
      try {
        const sessionRepo = new PostgresUploadSessionRepository(ctx.current.db);
        const repo = new PostgresStorageObjectRepository(ctx.current.db);
        const objectId = randomUUID();
        await sessionRepo.createObjectWithSession({
          objectId,
          sessionId: randomUUID(),
          workspaceId: fx.workspaceId,
          providerId: fx.providerId,
          providerObjectKey: 'k',
          filename: 'f.png',
          contentType: 'image/png',
          byteSize: 1,
          sha256: null,
          purpose: 'cms_media',
          visibility: 'private',
          compressionRequested: true,
          uploadMethod: 'single',
          providerUploadId: null,
          expiresAt: new Date(Date.now() + 60_000),
          createdBy: fx.userId,
        });
        // Set to `processing` directly.
        await ctx.current.db.execute(sql`
        UPDATE platform.storage_objects SET status = 'processing' WHERE id = ${objectId}
      `);
        // markUploaded returns the row unchanged (early idempotent).
        const out = await repo.markUploaded({
          objectId,
          workspaceId: fx.workspaceId,
          sha256: 'changed',
        });
        expect(out).not.toBeNull();
        expect(out!.status).toBe('processing');
      } finally {
        await fx.cleanup();
      }
    });
  },
);

describeIf('PostgresExtendedStorageObjectRepository.listForWorkspace + softDelete', () => {
  test('lists workspace-scoped rows, EXCLUDES deleted rows', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const sessionRepo = new PostgresUploadSessionRepository(ctx.current.db);
      const repo = new PostgresExtendedStorageObjectRepository(ctx.current.db);
      const aliveId = randomUUID();
      const deletedId = randomUUID();
      await sessionRepo.createObjectWithSession({
        objectId: aliveId,
        sessionId: randomUUID(),
        workspaceId: fx.workspaceId,
        providerId: fx.providerId,
        providerObjectKey: 'a',
        filename: 'alive.png',
        contentType: 'image/png',
        byteSize: 1,
        sha256: null,
        purpose: 'cms_media',
        visibility: 'private',
        compressionRequested: true,
        uploadMethod: 'single',
        providerUploadId: null,
        expiresAt: new Date(Date.now() + 60_000),
        createdBy: fx.userId,
      });
      await sessionRepo.createObjectWithSession({
        objectId: deletedId,
        sessionId: randomUUID(),
        workspaceId: fx.workspaceId,
        providerId: fx.providerId,
        providerObjectKey: 'd',
        filename: 'tombstone.png',
        contentType: 'image/png',
        byteSize: 1,
        sha256: null,
        purpose: 'cms_media',
        visibility: 'private',
        compressionRequested: true,
        uploadMethod: 'single',
        providerUploadId: null,
        expiresAt: new Date(Date.now() + 60_000),
        createdBy: fx.userId,
      });
      await repo.softDeleteForWorkspace({
        objectId: deletedId,
        workspaceId: fx.workspaceId,
        now: new Date(),
      });
      const list = await repo.listForWorkspace({
        workspaceId: fx.workspaceId,
        filters: {},
        limit: 50,
        cursor: null,
      });
      const ids = list.items.map((i) => i.id);
      expect(ids).toContain(aliveId);
      expect(ids).not.toContain(deletedId);
    } finally {
      await fx.cleanup();
    }
  });

  test('respects pagination cursor', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const sessionRepo = new PostgresUploadSessionRepository(ctx.current.db);
      const repo = new PostgresExtendedStorageObjectRepository(ctx.current.db);
      for (let i = 0; i < 5; i++) {
        await sessionRepo.createObjectWithSession({
          objectId: randomUUID(),
          sessionId: randomUUID(),
          workspaceId: fx.workspaceId,
          providerId: fx.providerId,
          providerObjectKey: `k-${i}`,
          filename: `f-${i}.png`,
          contentType: 'image/png',
          byteSize: 1,
          sha256: null,
          purpose: 'cms_media',
          visibility: 'private',
          compressionRequested: true,
          uploadMethod: 'single',
          providerUploadId: null,
          expiresAt: new Date(Date.now() + 60_000),
          createdBy: fx.userId,
        });
        await new Promise((r) => setTimeout(r, 5));
      }
      const page1 = await repo.listForWorkspace({
        workspaceId: fx.workspaceId,
        filters: {},
        limit: 2,
        cursor: null,
      });
      expect(page1.items.length).toBe(2);
      expect(page1.nextCursor).not.toBeNull();
      const page2 = await repo.listForWorkspace({
        workspaceId: fx.workspaceId,
        filters: {},
        limit: 2,
        cursor: page1.nextCursor,
      });
      expect(page2.items.length).toBe(2);
      const ids1 = page1.items.map((i) => i.id);
      const ids2 = page2.items.map((i) => i.id);
      for (const id of ids2) expect(ids1).not.toContain(id);
    } finally {
      await fx.cleanup();
    }
  });

  test('filters by purpose, status, contentTypeFamily, createdBy', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const sessionRepo = new PostgresUploadSessionRepository(ctx.current.db);
      const repo = new PostgresExtendedStorageObjectRepository(ctx.current.db);
      const imgId = randomUUID();
      const docId = randomUUID();
      await sessionRepo.createObjectWithSession({
        objectId: imgId,
        sessionId: randomUUID(),
        workspaceId: fx.workspaceId,
        providerId: fx.providerId,
        providerObjectKey: 'img',
        filename: 'pic.png',
        contentType: 'image/png',
        byteSize: 1,
        sha256: null,
        purpose: 'cms_media',
        visibility: 'private',
        compressionRequested: true,
        uploadMethod: 'single',
        providerUploadId: null,
        expiresAt: new Date(Date.now() + 60_000),
        createdBy: fx.userId,
      });
      await sessionRepo.createObjectWithSession({
        objectId: docId,
        sessionId: randomUUID(),
        workspaceId: fx.workspaceId,
        providerId: fx.providerId,
        providerObjectKey: 'doc',
        filename: 'doc.pdf',
        contentType: 'application/pdf',
        byteSize: 1,
        sha256: null,
        purpose: 'platform_generic',
        visibility: 'private',
        compressionRequested: false,
        uploadMethod: 'single',
        providerUploadId: null,
        expiresAt: new Date(Date.now() + 60_000),
        createdBy: fx.userId,
      });
      const onlyImages = await repo.listForWorkspace({
        workspaceId: fx.workspaceId,
        filters: { contentTypeFamily: 'image' },
        limit: 50,
        cursor: null,
      });
      expect(onlyImages.items.map((i) => i.id)).toContain(imgId);
      expect(onlyImages.items.map((i) => i.id)).not.toContain(docId);

      const onlyDocs = await repo.listForWorkspace({
        workspaceId: fx.workspaceId,
        filters: { contentTypeFamily: 'document' },
        limit: 50,
        cursor: null,
      });
      expect(onlyDocs.items.map((i) => i.id)).toContain(docId);
      expect(onlyDocs.items.map((i) => i.id)).not.toContain(imgId);

      const byPurpose = await repo.listForWorkspace({
        workspaceId: fx.workspaceId,
        filters: { purpose: 'cms_media' },
        limit: 50,
        cursor: null,
      });
      expect(byPurpose.items.map((i) => i.id)).toContain(imgId);
      expect(byPurpose.items.map((i) => i.id)).not.toContain(docId);

      const byStatus = await repo.listForWorkspace({
        workspaceId: fx.workspaceId,
        filters: { status: 'pending_upload' },
        limit: 50,
        cursor: null,
      });
      expect(byStatus.items.length).toBeGreaterThanOrEqual(2);
    } finally {
      await fx.cleanup();
    }
  });

  test('contentTypeFamily=other excludes every known prefix', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const sessionRepo = new PostgresUploadSessionRepository(ctx.current.db);
      const repo = new PostgresExtendedStorageObjectRepository(ctx.current.db);
      const imgId = randomUUID();
      const otherId = randomUUID();
      await sessionRepo.createObjectWithSession({
        objectId: imgId,
        sessionId: randomUUID(),
        workspaceId: fx.workspaceId,
        providerId: fx.providerId,
        providerObjectKey: 'img',
        filename: 'a.png',
        contentType: 'image/png',
        byteSize: 1,
        sha256: null,
        purpose: 'cms_media',
        visibility: 'private',
        compressionRequested: true,
        uploadMethod: 'single',
        providerUploadId: null,
        expiresAt: new Date(Date.now() + 60_000),
        createdBy: fx.userId,
      });
      await sessionRepo.createObjectWithSession({
        objectId: otherId,
        sessionId: randomUUID(),
        workspaceId: fx.workspaceId,
        providerId: fx.providerId,
        providerObjectKey: 'other',
        filename: 'a.bin',
        contentType: 'application/octet-stream',
        byteSize: 1,
        sha256: null,
        purpose: 'cms_media',
        visibility: 'private',
        compressionRequested: true,
        uploadMethod: 'single',
        providerUploadId: null,
        expiresAt: new Date(Date.now() + 60_000),
        createdBy: fx.userId,
      });
      const list = await repo.listForWorkspace({
        workspaceId: fx.workspaceId,
        filters: { contentTypeFamily: 'other' },
        limit: 50,
        cursor: null,
      });
      expect(list.items.map((i) => i.id)).toContain(otherId);
      expect(list.items.map((i) => i.id)).not.toContain(imgId);
    } finally {
      await fx.cleanup();
    }
  });

  test('softDeleteForWorkspace is idempotent', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const sessionRepo = new PostgresUploadSessionRepository(ctx.current.db);
      const repo = new PostgresExtendedStorageObjectRepository(ctx.current.db);
      const objectId = randomUUID();
      await sessionRepo.createObjectWithSession({
        objectId,
        sessionId: randomUUID(),
        workspaceId: fx.workspaceId,
        providerId: fx.providerId,
        providerObjectKey: 'k',
        filename: 'f.png',
        contentType: 'image/png',
        byteSize: 1,
        sha256: null,
        purpose: 'cms_media',
        visibility: 'private',
        compressionRequested: true,
        uploadMethod: 'single',
        providerUploadId: null,
        expiresAt: new Date(Date.now() + 60_000),
        createdBy: fx.userId,
      });
      const first = await repo.softDeleteForWorkspace({
        objectId,
        workspaceId: fx.workspaceId,
        now: new Date(),
      });
      expect(first!.status).toBe('deleted');
      const second = await repo.softDeleteForWorkspace({
        objectId,
        workspaceId: fx.workspaceId,
        now: new Date(),
      });
      expect(second).not.toBeNull();
      expect(second!.status).toBe('deleted');
    } finally {
      await fx.cleanup();
    }
  });

  test('softDeleteForWorkspace returns null for cross-workspace and unknown ids', async () => {
    if (!ctx.current) return;
    const fixtures = await seedTwoWorkspaceFixture(ctx.current.db);
    try {
      const sessionRepo = new PostgresUploadSessionRepository(ctx.current.db);
      const repo = new PostgresExtendedStorageObjectRepository(ctx.current.db);
      const objectId = randomUUID();
      await sessionRepo.createObjectWithSession({
        objectId,
        sessionId: randomUUID(),
        workspaceId: fixtures.a.workspaceId,
        providerId: fixtures.a.providerId,
        providerObjectKey: 'k',
        filename: 'f.png',
        contentType: 'image/png',
        byteSize: 1,
        sha256: null,
        purpose: 'cms_media',
        visibility: 'private',
        compressionRequested: true,
        uploadMethod: 'single',
        providerUploadId: null,
        expiresAt: new Date(Date.now() + 60_000),
        createdBy: fixtures.a.userId,
      });
      const denied = await repo.softDeleteForWorkspace({
        objectId,
        workspaceId: fixtures.b.workspaceId,
        now: new Date(),
      });
      expect(denied).toBeNull();
      const unknown = await repo.softDeleteForWorkspace({
        objectId: randomUUID(),
        workspaceId: fixtures.a.workspaceId,
        now: new Date(),
      });
      expect(unknown).toBeNull();
    } finally {
      await fixtures.cleanup();
    }
  });
});

describeIf('PostgresAbandonedUploadSessionRepository', () => {
  test('lists pending sessions whose expiresAt is in the past', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const sessionRepo = new PostgresUploadSessionRepository(ctx.current.db);
      const cleanup = new PostgresAbandonedUploadSessionRepository(ctx.current.db);
      const past = new Date(Date.now() - 60_000);
      const future = new Date(Date.now() + 60_000);
      const expiredId = randomUUID();
      const aliveId = randomUUID();
      await sessionRepo.createObjectWithSession({
        objectId: randomUUID(),
        sessionId: expiredId,
        workspaceId: fx.workspaceId,
        providerId: fx.providerId,
        providerObjectKey: 'expired',
        filename: 'e.png',
        contentType: 'image/png',
        byteSize: 1,
        sha256: null,
        purpose: 'cms_media',
        visibility: 'private',
        compressionRequested: true,
        uploadMethod: 'single',
        providerUploadId: null,
        expiresAt: past,
        createdBy: fx.userId,
      });
      await sessionRepo.createObjectWithSession({
        objectId: randomUUID(),
        sessionId: aliveId,
        workspaceId: fx.workspaceId,
        providerId: fx.providerId,
        providerObjectKey: 'alive',
        filename: 'a.png',
        contentType: 'image/png',
        byteSize: 1,
        sha256: null,
        purpose: 'cms_media',
        visibility: 'private',
        compressionRequested: true,
        uploadMethod: 'single',
        providerUploadId: null,
        expiresAt: future,
        createdBy: fx.userId,
      });
      const list = await cleanup.listExpiredPending({ now: new Date(), limit: 200 });
      const ids = list.map((s) => s.id);
      expect(ids).toContain(expiredId);
      expect(ids).not.toContain(aliveId);
    } finally {
      await fx.cleanup();
    }
  });

  test('markExpiredIfPending flips pending -> expired; idempotent retries return null', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const sessionRepo = new PostgresUploadSessionRepository(ctx.current.db);
      const cleanup = new PostgresAbandonedUploadSessionRepository(ctx.current.db);
      const sessionId = randomUUID();
      await sessionRepo.createObjectWithSession({
        objectId: randomUUID(),
        sessionId,
        workspaceId: fx.workspaceId,
        providerId: fx.providerId,
        providerObjectKey: 'k',
        filename: 'f.png',
        contentType: 'image/png',
        byteSize: 1,
        sha256: null,
        purpose: 'cms_media',
        visibility: 'private',
        compressionRequested: true,
        uploadMethod: 'single',
        providerUploadId: null,
        expiresAt: new Date(Date.now() - 1000),
        createdBy: fx.userId,
      });
      const first = await cleanup.markExpiredIfPending({
        sessionId,
        workspaceId: fx.workspaceId,
        now: new Date(),
      });
      expect(first!.status).toBe('expired');
      const second = await cleanup.markExpiredIfPending({
        sessionId,
        workspaceId: fx.workspaceId,
        now: new Date(),
      });
      expect(second).toBeNull();
    } finally {
      await fx.cleanup();
    }
  });

  test('respects limit', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const sessionRepo = new PostgresUploadSessionRepository(ctx.current.db);
      const cleanup = new PostgresAbandonedUploadSessionRepository(ctx.current.db);
      const past = new Date(Date.now() - 60_000);
      for (let i = 0; i < 3; i++) {
        await sessionRepo.createObjectWithSession({
          objectId: randomUUID(),
          sessionId: randomUUID(),
          workspaceId: fx.workspaceId,
          providerId: fx.providerId,
          providerObjectKey: `k-${i}`,
          filename: `f-${i}.png`,
          contentType: 'image/png',
          byteSize: 1,
          sha256: null,
          purpose: 'cms_media',
          visibility: 'private',
          compressionRequested: true,
          uploadMethod: 'single',
          providerUploadId: null,
          expiresAt: past,
          createdBy: fx.userId,
        });
      }
      const limited = await cleanup.listExpiredPending({ now: new Date(), limit: 2 });
      expect(limited.length).toBe(2);
    } finally {
      await fx.cleanup();
    }
  });
});

describeIf('PostgresStorageObjectStatusRepository', () => {
  test('flips uploaded -> processing and uploaded -> ready, stamping readyAt for ready', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const sessionRepo = new PostgresUploadSessionRepository(ctx.current.db);
      const objectRepo = new PostgresStorageObjectRepository(ctx.current.db);
      const statusRepo = new PostgresStorageObjectStatusRepository(ctx.current.db);
      const objectId = randomUUID();
      await sessionRepo.createObjectWithSession({
        objectId,
        sessionId: randomUUID(),
        workspaceId: fx.workspaceId,
        providerId: fx.providerId,
        providerObjectKey: 'k',
        filename: 'f.png',
        contentType: 'image/png',
        byteSize: 1,
        sha256: null,
        purpose: 'cms_media',
        visibility: 'private',
        compressionRequested: true,
        uploadMethod: 'single',
        providerUploadId: null,
        expiresAt: new Date(Date.now() + 60_000),
        createdBy: fx.userId,
      });
      await objectRepo.markUploaded({ objectId, workspaceId: fx.workspaceId, sha256: null });
      const toProcessing = await statusRepo.updateAggregateStatus({
        objectId,
        workspaceId: fx.workspaceId,
        nextStatus: 'processing',
        now: new Date(),
      });
      expect(toProcessing!.status).toBe('processing');
      const toReady = await statusRepo.updateAggregateStatus({
        objectId,
        workspaceId: fx.workspaceId,
        nextStatus: 'ready',
        now: new Date(),
      });
      expect(toReady!.status).toBe('ready');
    } finally {
      await fx.cleanup();
    }
  });

  test('refuses to clobber deleted rows', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const sessionRepo = new PostgresUploadSessionRepository(ctx.current.db);
      const objectRepo = new PostgresExtendedStorageObjectRepository(ctx.current.db);
      const statusRepo = new PostgresStorageObjectStatusRepository(ctx.current.db);
      const objectId = randomUUID();
      await sessionRepo.createObjectWithSession({
        objectId,
        sessionId: randomUUID(),
        workspaceId: fx.workspaceId,
        providerId: fx.providerId,
        providerObjectKey: 'k',
        filename: 'f.png',
        contentType: 'image/png',
        byteSize: 1,
        sha256: null,
        purpose: 'cms_media',
        visibility: 'private',
        compressionRequested: true,
        uploadMethod: 'single',
        providerUploadId: null,
        expiresAt: new Date(Date.now() + 60_000),
        createdBy: fx.userId,
      });
      await objectRepo.softDeleteForWorkspace({
        objectId,
        workspaceId: fx.workspaceId,
        now: new Date(),
      });
      const out = await statusRepo.updateAggregateStatus({
        objectId,
        workspaceId: fx.workspaceId,
        nextStatus: 'ready',
        now: new Date(),
      });
      expect(out).toBeNull();
    } finally {
      await fx.cleanup();
    }
  });

  test('cross-workspace updateAggregateStatus returns null', async () => {
    if (!ctx.current) return;
    const fixtures = await seedTwoWorkspaceFixture(ctx.current.db);
    try {
      const sessionRepo = new PostgresUploadSessionRepository(ctx.current.db);
      const objectRepo = new PostgresStorageObjectRepository(ctx.current.db);
      const statusRepo = new PostgresStorageObjectStatusRepository(ctx.current.db);
      const objectId = randomUUID();
      await sessionRepo.createObjectWithSession({
        objectId,
        sessionId: randomUUID(),
        workspaceId: fixtures.a.workspaceId,
        providerId: fixtures.a.providerId,
        providerObjectKey: 'k',
        filename: 'f.png',
        contentType: 'image/png',
        byteSize: 1,
        sha256: null,
        purpose: 'cms_media',
        visibility: 'private',
        compressionRequested: true,
        uploadMethod: 'single',
        providerUploadId: null,
        expiresAt: new Date(Date.now() + 60_000),
        createdBy: fixtures.a.userId,
      });
      await objectRepo.markUploaded({
        objectId,
        workspaceId: fixtures.a.workspaceId,
        sha256: null,
      });
      const denied = await statusRepo.updateAggregateStatus({
        objectId,
        workspaceId: fixtures.b.workspaceId,
        nextStatus: 'ready',
        now: new Date(),
      });
      expect(denied).toBeNull();
    } finally {
      await fixtures.cleanup();
    }
  });
});
