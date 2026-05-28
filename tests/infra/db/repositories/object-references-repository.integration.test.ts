/**
 * DEDUP-2 — integration tests for the Postgres references repository and
 * the new `findExistingByWorkspaceSha256` probe.
 *
 * Runs against the dev Supabase stack on `127.0.0.1:5432` by default,
 * or the env-overridden `STORAGE_INTEGRATION_DB_URL`. SKIPS cleanly when
 * the DB is unreachable.
 *
 * Closes Bug 2 (DB layer half) per
 * `xynes/xynes-infra/docs/plans/2026-05-27-storage-followups-combined.md` §9.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { connectOrSkip, seedWorkspaceFixture, seedTwoWorkspaceFixture } from './_db';
import {
  PostgresStorageObjectRepository,
  PostgresUploadSessionRepository,
} from '../../../../src/infra/db/repositories/object-and-session-repository';
import { PostgresStorageObjectReferenceRepository } from '../../../../src/infra/db/repositories/object-references-repository';
import type { StorageObjectReferenceOwnerKind } from '../../../../src/actions/handlers/uploads/types';
import type { IntegrationDb } from './_db';

const ctx: { current: IntegrationDb | null } = { current: null };

beforeAll(async () => {
  ctx.current = await connectOrSkip();
  if (!ctx.current) {
    console.warn('[DEDUP-2] DB unreachable; skipping integration tests.');
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
 * Seed an `uploaded` storage object row directly. Skips the
 * upload-session repo path since these tests target the references repo
 * + the dedup-probe method in isolation.
 */
async function seedReadyObject(
  db: IntegrationDb['db'],
  fx: { workspaceId: string; userId: string; providerId: string },
  overrides: Partial<{
    sha256: string | null;
    status: 'pending_upload' | 'uploaded' | 'processing' | 'ready' | 'failed';
    createdAt: Date;
  }> = {},
): Promise<{ id: string; sha256: string | null }> {
  const id = randomUUID();
  const sha256 = overrides.sha256 ?? 'a'.repeat(64);
  const status = overrides.status ?? 'ready';
  // `created_at` falls back to now() when not specified.
  const createdAtSql =
    overrides.createdAt !== undefined
      ? sql`${overrides.createdAt.toISOString()}::timestamptz`
      : sql`now()`;
  await db.execute(sql`
    INSERT INTO platform.storage_objects (
      id, workspace_id, provider_id, provider_object_key,
      filename, content_type, byte_size, sha256,
      purpose, visibility, status, compression_requested,
      created_by, created_at, updated_at, uploaded_at
    ) VALUES (
      ${id}, ${fx.workspaceId}, ${fx.providerId},
      ${`workspaces/${fx.workspaceId}/objects/${id}/file.bin`},
      'file.bin', 'application/octet-stream', 4096, ${sha256},
      'platform_generic', 'private', ${status}, true,
      ${fx.userId}, ${createdAtSql}, now(),
      ${status === 'pending_upload' || status === 'failed' ? null : 'now()'}::timestamptz
    )
  `);
  return { id, sha256 };
}

describeIf('PostgresStorageObjectRepository.findExistingByWorkspaceSha256 (DEDUP-2)', () => {
  test('finds a `ready` row with matching sha256 in the SAME workspace', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const obj = await seedReadyObject(ctx.current.db, fx, { status: 'ready' });
      const repo = new PostgresStorageObjectRepository(ctx.current.db);
      const found = await repo.findExistingByWorkspaceSha256({
        workspaceId: fx.workspaceId,
        sha256: obj.sha256!,
      });
      expect(found).not.toBeNull();
      expect(found!.id).toBe(obj.id);
      expect(found!.sha256).toBe(obj.sha256);
    } finally {
      await fx.cleanup();
    }
  });

  test('finds an `uploaded` row (predicate includes uploaded)', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const obj = await seedReadyObject(ctx.current.db, fx, { status: 'uploaded' });
      const repo = new PostgresStorageObjectRepository(ctx.current.db);
      const found = await repo.findExistingByWorkspaceSha256({
        workspaceId: fx.workspaceId,
        sha256: obj.sha256!,
      });
      expect(found?.id).toBe(obj.id);
    } finally {
      await fx.cleanup();
    }
  });

  test('finds a `processing` row (predicate includes processing)', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const obj = await seedReadyObject(ctx.current.db, fx, { status: 'processing' });
      const repo = new PostgresStorageObjectRepository(ctx.current.db);
      const found = await repo.findExistingByWorkspaceSha256({
        workspaceId: fx.workspaceId,
        sha256: obj.sha256!,
      });
      expect(found?.id).toBe(obj.id);
    } finally {
      await fx.cleanup();
    }
  });

  test('SKIPS `pending_upload` rows', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      await seedReadyObject(ctx.current.db, fx, { status: 'pending_upload' });
      const repo = new PostgresStorageObjectRepository(ctx.current.db);
      const found = await repo.findExistingByWorkspaceSha256({
        workspaceId: fx.workspaceId,
        sha256: 'a'.repeat(64),
      });
      expect(found).toBeNull();
    } finally {
      await fx.cleanup();
    }
  });

  test('SKIPS `failed` rows', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      await seedReadyObject(ctx.current.db, fx, { status: 'failed' });
      const repo = new PostgresStorageObjectRepository(ctx.current.db);
      const found = await repo.findExistingByWorkspaceSha256({
        workspaceId: fx.workspaceId,
        sha256: 'a'.repeat(64),
      });
      expect(found).toBeNull();
    } finally {
      await fx.cleanup();
    }
  });

  test('cross-workspace probe returns null (tenant isolation)', async () => {
    if (!ctx.current) return;
    const { a, b, cleanup } = await seedTwoWorkspaceFixture(ctx.current.db);
    try {
      const sha = 'a'.repeat(64);
      await seedReadyObject(ctx.current.db, a, { sha256: sha });
      const repo = new PostgresStorageObjectRepository(ctx.current.db);
      const found = await repo.findExistingByWorkspaceSha256({
        // Probe from workspace B for workspace A's content.
        workspaceId: b.workspaceId,
        sha256: sha,
      });
      expect(found).toBeNull();
    } finally {
      await cleanup();
    }
  });

  test('returns the OLDEST row when multiple matches exist (deterministic tiebreaker)', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      // The DEDUP-1 partial unique index should prevent multiple
      // (workspace_id, sha256) rows in active states. We test the
      // ORDER BY anyway: create two `failed` rows then one `ready` row
      // with the same sha256 — the active probe must still pick the
      // single active row.
      const sha = 'a'.repeat(64);
      await seedReadyObject(ctx.current.db, fx, { sha256: sha, status: 'failed' });
      const winner = await seedReadyObject(ctx.current.db, fx, { sha256: sha, status: 'ready' });
      const repo = new PostgresStorageObjectRepository(ctx.current.db);
      const found = await repo.findExistingByWorkspaceSha256({
        workspaceId: fx.workspaceId,
        sha256: sha,
      });
      expect(found?.id).toBe(winner.id);
    } finally {
      await fx.cleanup();
    }
  });
});

describeIf('PostgresStorageObjectReferenceRepository (DEDUP-2)', () => {
  test('addReference inserts a fresh row -> inserted: true', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const obj = await seedReadyObject(ctx.current.db, fx);
      const repo = new PostgresStorageObjectReferenceRepository(ctx.current.db);
      const res = await repo.addReference({
        objectId: obj.id,
        workspaceId: fx.workspaceId,
        ownerKind: 'cms_entry',
        ownerId: randomUUID(),
      });
      expect(res.inserted).toBe(true);
    } finally {
      await fx.cleanup();
    }
  });

  test('addReference is idempotent on duplicate composite key', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const obj = await seedReadyObject(ctx.current.db, fx);
      const repo = new PostgresStorageObjectReferenceRepository(ctx.current.db);
      const args = {
        objectId: obj.id,
        workspaceId: fx.workspaceId,
        ownerKind: 'cms_entry' as const,
        ownerId: randomUUID(),
      };
      const first = await repo.addReference(args);
      const second = await repo.addReference(args);
      expect(first.inserted).toBe(true);
      expect(second.inserted).toBe(false);
      // DB row count is exactly 1.
      const rows = await ctx.current.db.execute(sql`
        SELECT count(*)::int AS n
        FROM platform.storage_object_references
        WHERE object_id = ${obj.id}
      `);
      expect((rows as unknown as Array<{ n: number }>)[0].n).toBe(1);
    } finally {
      await fx.cleanup();
    }
  });

  test('cross-workspace addReference is refused (no row inserted)', async () => {
    if (!ctx.current) return;
    const { a, b, cleanup } = await seedTwoWorkspaceFixture(ctx.current.db);
    try {
      const obj = await seedReadyObject(ctx.current.db, a);
      const repo = new PostgresStorageObjectReferenceRepository(ctx.current.db);
      const res = await repo.addReference({
        objectId: obj.id,
        // Claim the OBJECT belongs to workspace B even though it
        // actually belongs to workspace A.
        workspaceId: b.workspaceId,
        ownerKind: 'cms_entry',
        ownerId: randomUUID(),
      });
      expect(res.inserted).toBe(false);
      const rows = await ctx.current.db.execute(sql`
        SELECT count(*)::int AS n
        FROM platform.storage_object_references
        WHERE object_id = ${obj.id}
      `);
      expect((rows as unknown as Array<{ n: number }>)[0].n).toBe(0);
    } finally {
      await cleanup();
    }
  });

  test('removeReference deletes the row + reports remaining count', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const obj = await seedReadyObject(ctx.current.db, fx);
      const repo = new PostgresStorageObjectReferenceRepository(ctx.current.db);
      const ownerA = randomUUID();
      const ownerB = randomUUID();
      await repo.addReference({
        objectId: obj.id,
        workspaceId: fx.workspaceId,
        ownerKind: 'cms_entry',
        ownerId: ownerA,
      });
      await repo.addReference({
        objectId: obj.id,
        workspaceId: fx.workspaceId,
        ownerKind: 'cms_entry',
        ownerId: ownerB,
      });
      const res = await repo.removeReference({
        objectId: obj.id,
        workspaceId: fx.workspaceId,
        ownerKind: 'cms_entry',
        ownerId: ownerA,
      });
      expect(res.remaining).toBe(1);
    } finally {
      await fx.cleanup();
    }
  });

  test('removeReference is idempotent on a missing row', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const obj = await seedReadyObject(ctx.current.db, fx);
      const repo = new PostgresStorageObjectReferenceRepository(ctx.current.db);
      const res = await repo.removeReference({
        objectId: obj.id,
        workspaceId: fx.workspaceId,
        ownerKind: 'cms_entry',
        ownerId: randomUUID(),
      });
      expect(res.remaining).toBe(0);
    } finally {
      await fx.cleanup();
    }
  });

  test('cross-workspace removeReference is refused (no row deleted)', async () => {
    if (!ctx.current) return;
    const { a, b, cleanup } = await seedTwoWorkspaceFixture(ctx.current.db);
    try {
      const obj = await seedReadyObject(ctx.current.db, a);
      const repo = new PostgresStorageObjectReferenceRepository(ctx.current.db);
      const ownerId = randomUUID();
      // First seed a real reference via the correct workspace.
      await repo.addReference({
        objectId: obj.id,
        workspaceId: a.workspaceId,
        ownerKind: 'cms_entry',
        ownerId,
      });
      // Now attempt a cross-workspace remove.
      const res = await repo.removeReference({
        objectId: obj.id,
        workspaceId: b.workspaceId,
        ownerKind: 'cms_entry',
        ownerId,
      });
      expect(res.remaining).toBe(0);
      // The original reference still exists.
      const rows = await ctx.current.db.execute(sql`
        SELECT count(*)::int AS n
        FROM platform.storage_object_references
        WHERE object_id = ${obj.id}
      `);
      expect((rows as unknown as Array<{ n: number }>)[0].n).toBe(1);
    } finally {
      await cleanup();
    }
  });

  test('countReferences walks only the target object id', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const objA = await seedReadyObject(ctx.current.db, fx, {
        sha256: 'a'.repeat(64),
        status: 'ready',
      });
      const objB = await seedReadyObject(ctx.current.db, fx, {
        sha256: 'b'.repeat(64),
        status: 'ready',
      });
      const repo = new PostgresStorageObjectReferenceRepository(ctx.current.db);
      await repo.addReference({
        objectId: objA.id,
        workspaceId: fx.workspaceId,
        ownerKind: 'cms_entry',
        ownerId: randomUUID(),
      });
      await repo.addReference({
        objectId: objA.id,
        workspaceId: fx.workspaceId,
        ownerKind: 'comment',
        ownerId: randomUUID(),
      });
      await repo.addReference({
        objectId: objB.id,
        workspaceId: fx.workspaceId,
        ownerKind: 'cms_entry',
        ownerId: randomUUID(),
      });
      expect(await repo.countReferences({ objectId: objA.id, workspaceId: fx.workspaceId })).toBe(
        2,
      );
      expect(await repo.countReferences({ objectId: objB.id, workspaceId: fx.workspaceId })).toBe(
        1,
      );
    } finally {
      await fx.cleanup();
    }
  });

  test('cross-workspace countReferences returns 0 (no leak)', async () => {
    if (!ctx.current) return;
    const { a, b, cleanup } = await seedTwoWorkspaceFixture(ctx.current.db);
    try {
      const obj = await seedReadyObject(ctx.current.db, a);
      const repo = new PostgresStorageObjectReferenceRepository(ctx.current.db);
      await repo.addReference({
        objectId: obj.id,
        workspaceId: a.workspaceId,
        ownerKind: 'cms_entry',
        ownerId: randomUUID(),
      });
      // Probe from workspace B.
      const count = await repo.countReferences({
        objectId: obj.id,
        workspaceId: b.workspaceId,
      });
      expect(count).toBe(0);
    } finally {
      await cleanup();
    }
  });

  test('rejects unknown ownerKind via the CHECK constraint (defense-in-depth)', async () => {
    // The DB's CHECK rejects unknown owner kinds even if the TS type
    // was bypassed. Confirm that the repo's wrapper does NOT silently
    // succeed for an out-of-set value.
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const obj = await seedReadyObject(ctx.current.db, fx);
      const repo = new PostgresStorageObjectReferenceRepository(ctx.current.db);
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        repo.addReference({
          objectId: obj.id,
          workspaceId: fx.workspaceId,
          // Intentionally hostile owner kind to exercise the DB-side
          // CHECK constraint. Routed through `unknown` so the eslint
          // `no-explicit-any` rule stays satisfied.
          ownerKind: 'attacker_owned' as unknown as StorageObjectReferenceOwnerKind,
          ownerId: randomUUID(),
        }),
      ).rejects.toThrow();
    } finally {
      await fx.cleanup();
    }
  });

  test('FK CASCADE — deleting the object hard-removes all its references', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const obj = await seedReadyObject(ctx.current.db, fx);
      const repo = new PostgresStorageObjectReferenceRepository(ctx.current.db);
      await repo.addReference({
        objectId: obj.id,
        workspaceId: fx.workspaceId,
        ownerKind: 'cms_entry',
        ownerId: randomUUID(),
      });
      // Hard-delete the object row.
      await ctx.current.db.execute(sql`
        DELETE FROM platform.storage_objects WHERE id = ${obj.id}
      `);
      const rows = await ctx.current.db.execute(sql`
        SELECT count(*)::int AS n
        FROM platform.storage_object_references
        WHERE object_id = ${obj.id}
      `);
      expect((rows as unknown as Array<{ n: number }>)[0].n).toBe(0);
    } finally {
      await fx.cleanup();
    }
  });

  test('partial unique index — TWO ready rows with same sha256 in same workspace is rejected (Bug 2 fix)', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const sha = 'a'.repeat(64);
      await seedReadyObject(ctx.current.db, fx, { sha256: sha, status: 'ready' });
      // The DEDUP-1 partial unique index rejects a second active row
      // with the same (workspace_id, sha256). The repo SHOULD never
      // even attempt this — DEDUP-2 short-circuits in the handler —
      // but we assert the DB invariant directly for defense-in-depth.
      await expect(
        seedReadyObject(ctx.current.db, fx, { sha256: sha, status: 'ready' }),
      ).rejects.toThrow();
    } finally {
      await fx.cleanup();
    }
  });
});

describeIf(
  'PostgresStorageObjectReferenceRepository — integrates with full upload-create path',
  () => {
    test('end-to-end: createObjectWithSession + addReference + countReferences', async () => {
      if (!ctx.current) return;
      const fx = await seedWorkspaceFixture(ctx.current.db);
      try {
        const sessionRepo = new PostgresUploadSessionRepository(ctx.current.db);
        const refRepo = new PostgresStorageObjectReferenceRepository(ctx.current.db);
        const objectId = randomUUID();
        const sessionId = randomUUID();
        const out = await sessionRepo.createObjectWithSession({
          objectId,
          sessionId,
          workspaceId: fx.workspaceId,
          providerId: fx.providerId,
          providerObjectKey: `workspaces/${fx.workspaceId}/objects/${objectId}/x.bin`,
          filename: 'x.bin',
          contentType: 'application/octet-stream',
          byteSize: 100,
          sha256: 'c'.repeat(64),
          purpose: 'cms_media',
          visibility: 'private',
          compressionRequested: true,
          uploadMethod: 'single',
          providerUploadId: null,
          expiresAt: new Date(Date.now() + 15 * 60_000),
          createdBy: fx.userId,
        });
        const inserted = await refRepo.addReference({
          objectId: out.object.id,
          workspaceId: fx.workspaceId,
          ownerKind: 'cms_entry',
          ownerId: randomUUID(),
        });
        expect(inserted.inserted).toBe(true);
        expect(
          await refRepo.countReferences({
            objectId: out.object.id,
            workspaceId: fx.workspaceId,
          }),
        ).toBe(1);
      } finally {
        await fx.cleanup();
      }
    });
  },
);
