/**
 * DEDUP-1 integration tests — schema invariants for the content-hash
 * dedup index + the `platform.storage_object_references` join table.
 *
 * Runs against the dev Supabase stack on `127.0.0.1:5432` by default,
 * or the env-overridden `STORAGE_INTEGRATION_DB_URL`. Soft-skips when
 * the DB is unreachable (clean laptop, no docker).
 *
 * Each test seeds its own workspace fixture and relies on the
 * `ON DELETE CASCADE` from `platform.workspaces.id` to clear every
 * storage_* row tree on cleanup.
 *
 * What these tests cover (plan §8 acceptance criteria):
 *   - The partial unique index on `(workspace_id, sha256)` rejects
 *     duplicate `(workspace, sha256)` pairs whose status is in the
 *     active set (`uploaded` / `processing` / `ready`).
 *   - `pending_upload` and `failed` statuses are EXCLUDED from the
 *     unique constraint so retries still succeed.
 *   - Soft-delete (`status='deleted'`) unblocks a fresh insert of the
 *     same `(workspace, sha256)`.
 *   - Workspace-scoping: same `sha256` in two different workspaces is
 *     allowed; the unique index keys on `(workspace_id, sha256)`,
 *     never on `sha256` alone.
 *   - `storage_object_references` composite PK rejects duplicate
 *     `(object_id, owner_kind, owner_id)` triples.
 *   - `storage_object_references` workspace cascade: deleting the
 *     workspace clears the join rows via the storage_objects FK.
 *   - The `owner_kind` CHECK rejects unknown values.
 *
 * Out of scope (DEDUP-2 handler tests will cover):
 *   - The upload-create handler's short-circuit on dedup hit.
 *   - The delete handler's reference-counted soft-delete.
 *   - The DEDUP-2 storage-client behaviour.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { connectOrSkip, seedTwoWorkspaceFixture, seedWorkspaceFixture } from './_db';
import type { IntegrationDb } from './_db';

const ctx: { current: IntegrationDb | null } = { current: null };

beforeAll(async () => {
  ctx.current = await connectOrSkip();
  if (!ctx.current) {
    // eslint-disable-next-line no-console
    console.warn('[DEDUP-1] DB unreachable; skipping dedup schema integration tests.');
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
 * Extract the underlying `postgres` error from a Drizzle-wrapped throw.
 * Drizzle's `db.execute()` wraps the source `PostgresError` and exposes
 * it on `err.cause`. The original error carries `.code` (5-char SQLSTATE)
 * and `.constraint_name` (when the failure was a constraint violation).
 */
function pgError(err: unknown): { readonly code?: string; readonly constraint_name?: string } {
  const wrapped = err as { cause?: unknown };
  const cause = (wrapped.cause ?? err) as { code?: unknown; constraint_name?: unknown };
  return {
    code: typeof cause.code === 'string' ? cause.code : undefined,
    constraint_name: typeof cause.constraint_name === 'string' ? cause.constraint_name : undefined,
  };
}

/**
 * Insert a single `storage_objects` row with explicit values. Returns
 * the row id. Bypasses the upload-session repo so we can test schema
 * invariants directly without dragging the rest of STORAGE-FU-2 in.
 */
async function insertObject(params: {
  readonly db: IntegrationDb['db'];
  readonly workspaceId: string;
  readonly providerId: string;
  readonly sha256: string | null;
  readonly status: string;
  readonly providerObjectKeyHint?: string;
  readonly createdAt?: Date;
}): Promise<string> {
  const objectId = randomUUID();
  const providerObjectKey =
    params.providerObjectKeyHint ?? `workspaces/${params.workspaceId}/objects/${objectId}/file.bin`;
  // Soft-deleted rows must carry a non-null `deleted_at` per the
  // `storage_objects_deleted_consistency` CHECK from STORAGE-2.
  const deletedAtSql = params.status === 'deleted' ? sql`now()` : sql`NULL`;
  const createdAtSql = params.createdAt
    ? sql`${params.createdAt.toISOString()}::timestamptz`
    : sql`now()`;
  await params.db.execute(sql`
    INSERT INTO platform.storage_objects
      (id, workspace_id, provider_id, provider_object_key, filename, content_type,
       byte_size, sha256, purpose, visibility, status, compression_requested,
       created_at, updated_at, deleted_at)
    VALUES (
      ${objectId}, ${params.workspaceId}, ${params.providerId}, ${providerObjectKey},
      'file.bin', 'application/octet-stream', 1024, ${params.sha256}, 'platform_generic',
      'private', ${params.status}, true, ${createdAtSql}, now(), ${deletedAtSql}
    )
  `);
  return objectId;
}

describeIf('DEDUP-1 — workspace-scoped partial unique index on (workspace_id, sha256)', () => {
  test('rejects duplicate (workspace_id, sha256) when both rows are status=ready', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const sha = 'a'.repeat(64);
      await insertObject({
        db: ctx.current.db,
        workspaceId: fx.workspaceId,
        providerId: fx.providerId,
        sha256: sha,
        status: 'ready',
        providerObjectKeyHint: `workspaces/${fx.workspaceId}/objects/first/file.bin`,
      });
      let raised: Error | null = null;
      try {
        await insertObject({
          db: ctx.current.db,
          workspaceId: fx.workspaceId,
          providerId: fx.providerId,
          sha256: sha,
          status: 'ready',
          providerObjectKeyHint: `workspaces/${fx.workspaceId}/objects/second/file.bin`,
        });
      } catch (err) {
        raised = err as Error;
      }
      expect(raised).not.toBeNull();
      // Postgres unique-violation code is 23505. The error surface from
      // `postgres` library carries the code in `.code` and the index
      // name in `.constraint_name`. Drizzle wraps the source error on
      // `err.cause`; pgError() handles both layouts.
      const e = pgError(raised);
      expect(e.code).toBe('23505');
      expect(e.constraint_name).toBe('storage_objects_workspace_sha256_uidx');
    } finally {
      await fx.cleanup();
    }
  });

  test('allows duplicate (workspace_id, sha256) when one row is status=pending_upload', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const sha = 'b'.repeat(64);
      // First row: ready (covered by the partial unique index).
      await insertObject({
        db: ctx.current.db,
        workspaceId: fx.workspaceId,
        providerId: fx.providerId,
        sha256: sha,
        status: 'ready',
        providerObjectKeyHint: `workspaces/${fx.workspaceId}/objects/ready/file.bin`,
      });
      // Second row: pending_upload — predicate excludes this status so
      // the insert must succeed even though `(workspace_id, sha256)` matches.
      await insertObject({
        db: ctx.current.db,
        workspaceId: fx.workspaceId,
        providerId: fx.providerId,
        sha256: sha,
        status: 'pending_upload',
        providerObjectKeyHint: `workspaces/${fx.workspaceId}/objects/pending/file.bin`,
      });
      // Sanity: both rows are present.
      const rows = (await ctx.current.db.execute(sql`
        SELECT COUNT(*)::int AS n FROM platform.storage_objects
        WHERE workspace_id = ${fx.workspaceId} AND sha256 = ${sha}
      `)) as unknown as Array<{ n: number }>;
      expect(rows[0].n).toBe(2);
    } finally {
      await fx.cleanup();
    }
  });

  test('allows duplicate (workspace_id, sha256) when one row is status=failed', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const sha = 'c'.repeat(64);
      await insertObject({
        db: ctx.current.db,
        workspaceId: fx.workspaceId,
        providerId: fx.providerId,
        sha256: sha,
        status: 'failed',
        providerObjectKeyHint: `workspaces/${fx.workspaceId}/objects/failed/file.bin`,
      });
      // Fresh upload of the same content after a failure must succeed.
      await insertObject({
        db: ctx.current.db,
        workspaceId: fx.workspaceId,
        providerId: fx.providerId,
        sha256: sha,
        status: 'ready',
        providerObjectKeyHint: `workspaces/${fx.workspaceId}/objects/retry/file.bin`,
      });
      const rows = (await ctx.current.db.execute(sql`
        SELECT COUNT(*)::int AS n FROM platform.storage_objects
        WHERE workspace_id = ${fx.workspaceId} AND sha256 = ${sha}
      `)) as unknown as Array<{ n: number }>;
      expect(rows[0].n).toBe(2);
    } finally {
      await fx.cleanup();
    }
  });

  test('soft-deleting a row unblocks a fresh insert of the same (workspace_id, sha256)', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const sha = 'd'.repeat(64);
      const firstId = await insertObject({
        db: ctx.current.db,
        workspaceId: fx.workspaceId,
        providerId: fx.providerId,
        sha256: sha,
        status: 'ready',
        providerObjectKeyHint: `workspaces/${fx.workspaceId}/objects/first/file.bin`,
      });
      // Soft-delete the first row.
      await ctx.current.db.execute(sql`
        UPDATE platform.storage_objects
        SET status = 'deleted', deleted_at = now()
        WHERE id = ${firstId}
      `);
      // Fresh insert of the SAME (workspace, sha256) MUST succeed
      // because the partial index excludes deleted rows.
      await insertObject({
        db: ctx.current.db,
        workspaceId: fx.workspaceId,
        providerId: fx.providerId,
        sha256: sha,
        status: 'ready',
        providerObjectKeyHint: `workspaces/${fx.workspaceId}/objects/second/file.bin`,
      });
      const rows = (await ctx.current.db.execute(sql`
        SELECT COUNT(*)::int AS n FROM platform.storage_objects
        WHERE workspace_id = ${fx.workspaceId} AND sha256 = ${sha}
      `)) as unknown as Array<{ n: number }>;
      expect(rows[0].n).toBe(2);
    } finally {
      await fx.cleanup();
    }
  });

  test('cross-workspace: same sha256 in two workspaces is allowed (no tenant leak)', async () => {
    if (!ctx.current) return;
    const fx = await seedTwoWorkspaceFixture(ctx.current.db);
    try {
      const sha = 'e'.repeat(64);
      // Workspace A: ready.
      await insertObject({
        db: ctx.current.db,
        workspaceId: fx.a.workspaceId,
        providerId: fx.a.providerId,
        sha256: sha,
        status: 'ready',
        providerObjectKeyHint: `workspaces/${fx.a.workspaceId}/objects/file.bin`,
      });
      // Workspace B: ready — different workspace, MUST succeed.
      await insertObject({
        db: ctx.current.db,
        workspaceId: fx.b.workspaceId,
        providerId: fx.b.providerId,
        sha256: sha,
        status: 'ready',
        providerObjectKeyHint: `workspaces/${fx.b.workspaceId}/objects/file.bin`,
      });
      const aRows = (await ctx.current.db.execute(sql`
        SELECT COUNT(*)::int AS n FROM platform.storage_objects
        WHERE workspace_id = ${fx.a.workspaceId} AND sha256 = ${sha}
      `)) as unknown as Array<{ n: number }>;
      const bRows = (await ctx.current.db.execute(sql`
        SELECT COUNT(*)::int AS n FROM platform.storage_objects
        WHERE workspace_id = ${fx.b.workspaceId} AND sha256 = ${sha}
      `)) as unknown as Array<{ n: number }>;
      expect(aRows[0].n).toBe(1);
      expect(bRows[0].n).toBe(1);
    } finally {
      await fx.cleanup();
    }
  });

  test('legacy rows with NULL sha256 do not block fresh inserts', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      // Two legacy rows with NULL sha256 — partial index excludes both
      // (predicate requires `sha256 IS NOT NULL`).
      await insertObject({
        db: ctx.current.db,
        workspaceId: fx.workspaceId,
        providerId: fx.providerId,
        sha256: null,
        status: 'ready',
        providerObjectKeyHint: `workspaces/${fx.workspaceId}/objects/legacy-a/file.bin`,
      });
      await insertObject({
        db: ctx.current.db,
        workspaceId: fx.workspaceId,
        providerId: fx.providerId,
        sha256: null,
        status: 'ready',
        providerObjectKeyHint: `workspaces/${fx.workspaceId}/objects/legacy-b/file.bin`,
      });
      const rows = (await ctx.current.db.execute(sql`
        SELECT COUNT(*)::int AS n FROM platform.storage_objects
        WHERE workspace_id = ${fx.workspaceId} AND sha256 IS NULL
      `)) as unknown as Array<{ n: number }>;
      expect(rows[0].n).toBe(2);
    } finally {
      await fx.cleanup();
    }
  });
});

describeIf('DEDUP-1 — platform.storage_object_references', () => {
  test('inserts a single reference row keyed on (object_id, owner_kind, owner_id)', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const objectId = await insertObject({
        db: ctx.current.db,
        workspaceId: fx.workspaceId,
        providerId: fx.providerId,
        sha256: null,
        status: 'ready',
      });
      const ownerId = randomUUID();
      await ctx.current.db.execute(sql`
        INSERT INTO platform.storage_object_references (object_id, owner_kind, owner_id)
        VALUES (${objectId}, 'cms_entry', ${ownerId})
      `);
      const rows = (await ctx.current.db.execute(sql`
        SELECT owner_kind, owner_id
        FROM platform.storage_object_references
        WHERE object_id = ${objectId}
      `)) as unknown as Array<{ owner_kind: string; owner_id: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].owner_kind).toBe('cms_entry');
      expect(rows[0].owner_id).toBe(ownerId);
    } finally {
      await fx.cleanup();
    }
  });

  test('rejects duplicate (object_id, owner_kind, owner_id) via composite PK', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const objectId = await insertObject({
        db: ctx.current.db,
        workspaceId: fx.workspaceId,
        providerId: fx.providerId,
        sha256: null,
        status: 'ready',
      });
      const ownerId = randomUUID();
      await ctx.current.db.execute(sql`
        INSERT INTO platform.storage_object_references (object_id, owner_kind, owner_id)
        VALUES (${objectId}, 'comment', ${ownerId})
      `);
      let raised: Error | null = null;
      try {
        await ctx.current.db.execute(sql`
          INSERT INTO platform.storage_object_references (object_id, owner_kind, owner_id)
          VALUES (${objectId}, 'comment', ${ownerId})
        `);
      } catch (err) {
        raised = err as Error;
      }
      expect(raised).not.toBeNull();
      expect(pgError(raised).code).toBe('23505'); // unique violation
    } finally {
      await fx.cleanup();
    }
  });

  test('ON CONFLICT (object_id, owner_kind, owner_id) DO NOTHING is idempotent', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const objectId = await insertObject({
        db: ctx.current.db,
        workspaceId: fx.workspaceId,
        providerId: fx.providerId,
        sha256: null,
        status: 'ready',
      });
      const ownerId = randomUUID();
      const stmt = sql`
        INSERT INTO platform.storage_object_references (object_id, owner_kind, owner_id)
        VALUES (${objectId}, 'doc_service', ${ownerId})
        ON CONFLICT (object_id, owner_kind, owner_id) DO NOTHING
      `;
      await ctx.current.db.execute(stmt);
      await ctx.current.db.execute(stmt);
      await ctx.current.db.execute(stmt);
      const rows = (await ctx.current.db.execute(sql`
        SELECT COUNT(*)::int AS n FROM platform.storage_object_references
        WHERE object_id = ${objectId}
      `)) as unknown as Array<{ n: number }>;
      expect(rows[0].n).toBe(1);
    } finally {
      await fx.cleanup();
    }
  });

  test('allows multiple references per object across different owner_kind+owner_id', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const objectId = await insertObject({
        db: ctx.current.db,
        workspaceId: fx.workspaceId,
        providerId: fx.providerId,
        sha256: null,
        status: 'ready',
      });
      const owner1 = randomUUID();
      const owner2 = randomUUID();
      await ctx.current.db.execute(sql`
        INSERT INTO platform.storage_object_references (object_id, owner_kind, owner_id) VALUES
          (${objectId}, 'cms_entry', ${owner1}),
          (${objectId}, 'cms_entry', ${owner2}),
          (${objectId}, 'platform_generic', ${owner1})
      `);
      const rows = (await ctx.current.db.execute(sql`
        SELECT COUNT(*)::int AS n FROM platform.storage_object_references
        WHERE object_id = ${objectId}
      `)) as unknown as Array<{ n: number }>;
      expect(rows[0].n).toBe(3);
    } finally {
      await fx.cleanup();
    }
  });

  test('rejects unknown owner_kind via CHECK constraint', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const objectId = await insertObject({
        db: ctx.current.db,
        workspaceId: fx.workspaceId,
        providerId: fx.providerId,
        sha256: null,
        status: 'ready',
      });
      let raised: Error | null = null;
      try {
        await ctx.current.db.execute(sql`
          INSERT INTO platform.storage_object_references (object_id, owner_kind, owner_id)
          VALUES (${objectId}, 'malicious_kind', ${randomUUID()})
        `);
      } catch (err) {
        raised = err as Error;
      }
      expect(raised).not.toBeNull();
      // Postgres CHECK constraint violation code is 23514.
      expect(pgError(raised).code).toBe('23514');
    } finally {
      await fx.cleanup();
    }
  });

  test('ON DELETE CASCADE: deleting a storage_object clears its reference rows', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const objectId = await insertObject({
        db: ctx.current.db,
        workspaceId: fx.workspaceId,
        providerId: fx.providerId,
        sha256: null,
        status: 'ready',
      });
      await ctx.current.db.execute(sql`
        INSERT INTO platform.storage_object_references (object_id, owner_kind, owner_id) VALUES
          (${objectId}, 'workspace_logo', ${randomUUID()}),
          (${objectId}, 'user_avatar', ${randomUUID()})
      `);
      // Hard-delete the parent (rare; soft-delete is the norm but the
      // schema MUST cascade either way).
      await ctx.current.db.execute(sql`
        DELETE FROM platform.storage_objects WHERE id = ${objectId}
      `);
      const rows = (await ctx.current.db.execute(sql`
        SELECT COUNT(*)::int AS n FROM platform.storage_object_references
        WHERE object_id = ${objectId}
      `)) as unknown as Array<{ n: number }>;
      expect(rows[0].n).toBe(0);
    } finally {
      await fx.cleanup();
    }
  });

  test('workspace cascade transitively clears reference rows', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    const objectId = await insertObject({
      db: ctx.current.db,
      workspaceId: fx.workspaceId,
      providerId: fx.providerId,
      sha256: null,
      status: 'ready',
    });
    await ctx.current.db.execute(sql`
      INSERT INTO platform.storage_object_references (object_id, owner_kind, owner_id)
      VALUES (${objectId}, 'cms_entry', ${randomUUID()})
    `);
    // fx.cleanup() deletes the workspace, which cascades to storage_objects,
    // which cascades to storage_object_references. Verify no rows survive.
    await fx.cleanup();
    const rows = (await ctx.current.db.execute(sql`
      SELECT COUNT(*)::int AS n FROM platform.storage_object_references
      WHERE object_id = ${objectId}
    `)) as unknown as Array<{ n: number }>;
    expect(rows[0].n).toBe(0);
  });
});

/**
 * Codex P1 fix: pre-index reconciliation block in the DEDUP-1 migration.
 *
 * The migration MUST demote pre-existing duplicate `(workspace_id, sha256)`
 * rows BEFORE creating the partial unique index, otherwise the
 * `CREATE UNIQUE INDEX` aborts on any environment that already accumulated
 * legacy duplicates (which is exactly Bug 2's signature). These tests
 * simulate the reconciliation logic against synthetic duplicates and
 * assert the winner-selection contract.
 *
 * Tests that need to seed duplicates run inside a Drizzle transaction
 * that DROPs the partial unique index up-front (so duplicates can be
 * inserted), runs the reconciliation, asserts post-state, then throws a
 * sentinel error to force ROLLBACK. The dev DB index + rows survive the
 * test run untouched (verified by the index-count assertion after each
 * txn). Tests that don't need duplicates use the live index directly.
 *
 * Reconciliation contract:
 *   - Oldest row per (workspace_id, sha256) group wins (lowest created_at,
 *     then lowest id as tiebreaker). Status preserved.
 *   - All later duplicates flip to status='deleted', deleted_at=now(),
 *     failure_code='DEDUP_RECONCILED'.
 */
describeIf('DEDUP-1 — pre-index reconciliation (Codex P1 fix)', () => {
  const ROLLBACK_SENTINEL = '__DEDUP_RECONCILE_ROLLBACK_SENTINEL__';

  const RECONCILE_SQL = sql`
    WITH ranked_duplicates AS (
      SELECT
        id,
        workspace_id,
        sha256,
        ROW_NUMBER() OVER (
          PARTITION BY workspace_id, sha256
          ORDER BY created_at ASC, id ASC
        ) AS rn
      FROM platform.storage_objects
      WHERE sha256 IS NOT NULL
        AND status IN ('uploaded', 'processing', 'ready')
    )
    UPDATE platform.storage_objects
    SET status = 'deleted',
        deleted_at = now(),
        failure_code = 'DEDUP_RECONCILED',
        failure_message = 'Soft-deleted by DEDUP-1 migration; older duplicate is the dedup winner.',
        updated_at = now()
    WHERE id IN (SELECT id FROM ranked_duplicates WHERE rn > 1)
  `;

  async function txInsertObject(
    tx: IntegrationDb['db'],
    params: {
      readonly workspaceId: string;
      readonly providerId: string;
      readonly sha256: string | null;
      readonly status: string;
      readonly providerObjectKeyHint?: string;
      readonly createdAt?: Date;
    },
  ): Promise<string> {
    const objectId = randomUUID();
    const providerObjectKey =
      params.providerObjectKeyHint ??
      `workspaces/${params.workspaceId}/objects/${objectId}/file.bin`;
    const deletedAtSql = params.status === 'deleted' ? sql`now()` : sql`NULL`;
    const createdAtSql = params.createdAt
      ? sql`${params.createdAt.toISOString()}::timestamptz`
      : sql`now()`;
    await tx.execute(sql`
      INSERT INTO platform.storage_objects
        (id, workspace_id, provider_id, provider_object_key, filename, content_type,
         byte_size, sha256, purpose, visibility, status, compression_requested,
         created_at, updated_at, deleted_at)
      VALUES (
        ${objectId}, ${params.workspaceId}, ${params.providerId}, ${providerObjectKey},
        'file.bin', 'application/octet-stream', 1024, ${params.sha256}, 'platform_generic',
        'private', ${params.status}, true, ${createdAtSql}, now(), ${deletedAtSql}
      )
    `);
    return objectId;
  }

  /** Runs `work` inside a transaction with the dedup index dropped, then forces ROLLBACK. */
  async function withDroppedIndex(
    db: IntegrationDb['db'],
    work: (tx: IntegrationDb['db']) => Promise<void>,
  ): Promise<void> {
    await db
      .transaction(async (tx) => {
        await tx.execute(sql`DROP INDEX platform.storage_objects_workspace_sha256_uidx`);
        await work(tx);
        throw new Error(ROLLBACK_SENTINEL);
      })
      .catch((err: unknown) => {
        if (!(err instanceof Error) || err.message !== ROLLBACK_SENTINEL) {
          throw err;
        }
      });
  }

  async function assertIndexRestored(db: IntegrationDb['db']): Promise<void> {
    const idxCount = (await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM pg_indexes
      WHERE schemaname = 'platform'
        AND indexname = 'storage_objects_workspace_sha256_uidx'
    `)) as unknown as Array<{ n: number }>;
    expect(idxCount[0].n).toBe(1);
  }

  test('keeps the OLDEST row as the dedup winner; demotes later duplicates', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const sha = 'f'.repeat(64);
      await withDroppedIndex(ctx.current.db, async (tx) => {
        const winnerId = await txInsertObject(tx, {
          workspaceId: fx.workspaceId,
          providerId: fx.providerId,
          sha256: sha,
          status: 'ready',
          createdAt: new Date('2026-01-01T00:00:00Z'),
          providerObjectKeyHint: `workspaces/${fx.workspaceId}/objects/winner/file.bin`,
        });
        const loser1Id = await txInsertObject(tx, {
          workspaceId: fx.workspaceId,
          providerId: fx.providerId,
          sha256: sha,
          status: 'ready',
          createdAt: new Date('2026-02-01T00:00:00Z'),
          providerObjectKeyHint: `workspaces/${fx.workspaceId}/objects/loser1/file.bin`,
        });
        const loser2Id = await txInsertObject(tx, {
          workspaceId: fx.workspaceId,
          providerId: fx.providerId,
          sha256: sha,
          status: 'processing',
          createdAt: new Date('2026-03-01T00:00:00Z'),
          providerObjectKeyHint: `workspaces/${fx.workspaceId}/objects/loser2/file.bin`,
        });

        await tx.execute(RECONCILE_SQL);

        const winner = (await tx.execute(sql`
          SELECT status, failure_code, deleted_at IS NOT NULL AS has_deleted_at
          FROM platform.storage_objects WHERE id = ${winnerId}
        `)) as unknown as Array<{
          status: string;
          failure_code: string | null;
          has_deleted_at: boolean;
        }>;
        expect(winner[0].status).toBe('ready');
        expect(winner[0].failure_code).toBeNull();
        expect(winner[0].has_deleted_at).toBe(false);

        for (const loserId of [loser1Id, loser2Id]) {
          const loser = (await tx.execute(sql`
            SELECT status, failure_code, deleted_at IS NOT NULL AS has_deleted_at
            FROM platform.storage_objects WHERE id = ${loserId}
          `)) as unknown as Array<{
            status: string;
            failure_code: string | null;
            has_deleted_at: boolean;
          }>;
          expect(loser[0].status).toBe('deleted');
          expect(loser[0].failure_code).toBe('DEDUP_RECONCILED');
          expect(loser[0].has_deleted_at).toBe(true);
        }

        // After reconciliation, the partial unique index can be re-created
        // without conflict.
        await tx.execute(sql`
          CREATE UNIQUE INDEX storage_objects_workspace_sha256_uidx
            ON platform.storage_objects (workspace_id, sha256)
            WHERE sha256 IS NOT NULL AND status IN ('uploaded', 'processing', 'ready')
        `);
      });
      await assertIndexRestored(ctx.current.db);
    } finally {
      await fx.cleanup();
    }
  });

  test('breaks ties on equal created_at by lower id (deterministic winner selection)', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const sha = '1'.repeat(64);
      const sameTime = new Date('2026-01-01T00:00:00Z');
      await withDroppedIndex(ctx.current.db, async (tx) => {
        const allIds: string[] = [];
        for (const tag of ['a', 'b', 'c', 'd']) {
          allIds.push(
            await txInsertObject(tx, {
              workspaceId: fx.workspaceId,
              providerId: fx.providerId,
              sha256: sha,
              status: 'ready',
              createdAt: sameTime,
              providerObjectKeyHint: `workspaces/${fx.workspaceId}/objects/${tag}/file.bin`,
            }),
          );
        }

        await tx.execute(RECONCILE_SQL);

        const expectedWinner = [...allIds].sort()[0];
        const winners = (await tx.execute(sql`
          SELECT id FROM platform.storage_objects
          WHERE workspace_id = ${fx.workspaceId}
            AND sha256 = ${sha}
            AND status IN ('uploaded', 'processing', 'ready')
        `)) as unknown as Array<{ id: string }>;
        expect(winners).toHaveLength(1);
        expect(winners[0].id).toBe(expectedWinner);
      });
      await assertIndexRestored(ctx.current.db);
    } finally {
      await fx.cleanup();
    }
  });

  test('idempotent: re-running reconciliation after the first pass is a no-op', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const sha = '2'.repeat(64);
      await withDroppedIndex(ctx.current.db, async (tx) => {
        await txInsertObject(tx, {
          workspaceId: fx.workspaceId,
          providerId: fx.providerId,
          sha256: sha,
          status: 'ready',
          createdAt: new Date('2026-01-01T00:00:00Z'),
          providerObjectKeyHint: `workspaces/${fx.workspaceId}/objects/win/file.bin`,
        });
        const loserId = await txInsertObject(tx, {
          workspaceId: fx.workspaceId,
          providerId: fx.providerId,
          sha256: sha,
          status: 'ready',
          createdAt: new Date('2026-02-01T00:00:00Z'),
          providerObjectKeyHint: `workspaces/${fx.workspaceId}/objects/lose/file.bin`,
        });

        await tx.execute(RECONCILE_SQL);
        const after1 = (await tx.execute(sql`
          SELECT updated_at FROM platform.storage_objects WHERE id = ${loserId}
        `)) as unknown as Array<{ updated_at: Date }>;
        const updatedAt1 = after1[0].updated_at;

        await tx.execute(RECONCILE_SQL);
        const after2 = (await tx.execute(sql`
          SELECT updated_at FROM platform.storage_objects WHERE id = ${loserId}
        `)) as unknown as Array<{ updated_at: Date }>;
        expect(new Date(after2[0].updated_at).getTime()).toBe(new Date(updatedAt1).getTime());
      });
      await assertIndexRestored(ctx.current.db);
    } finally {
      await fx.cleanup();
    }
  });

  test('does NOT demote rows with sha256 IS NULL', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      // The dev index excludes NULL-sha256 rows via its predicate, so no
      // temp DROP needed.
      const a = await insertObject({
        db: ctx.current.db,
        workspaceId: fx.workspaceId,
        providerId: fx.providerId,
        sha256: null,
        status: 'ready',
        providerObjectKeyHint: `workspaces/${fx.workspaceId}/objects/null-a/file.bin`,
      });
      const b = await insertObject({
        db: ctx.current.db,
        workspaceId: fx.workspaceId,
        providerId: fx.providerId,
        sha256: null,
        status: 'ready',
        providerObjectKeyHint: `workspaces/${fx.workspaceId}/objects/null-b/file.bin`,
      });

      await ctx.current.db.execute(RECONCILE_SQL);

      for (const id of [a, b]) {
        const row = (await ctx.current.db.execute(sql`
          SELECT status, failure_code FROM platform.storage_objects WHERE id = ${id}
        `)) as unknown as Array<{ status: string; failure_code: string | null }>;
        expect(row[0].status).toBe('ready');
        expect(row[0].failure_code).toBeNull();
      }
    } finally {
      await fx.cleanup();
    }
  });

  test('does NOT demote duplicates across different workspaces (tenant isolation)', async () => {
    if (!ctx.current) return;
    const fx = await seedTwoWorkspaceFixture(ctx.current.db);
    try {
      const sha = '3'.repeat(64);
      // Workspace-scoped index permits same sha256 across workspaces; no
      // temp DROP needed.
      const aId = await insertObject({
        db: ctx.current.db,
        workspaceId: fx.a.workspaceId,
        providerId: fx.a.providerId,
        sha256: sha,
        status: 'ready',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        providerObjectKeyHint: `workspaces/${fx.a.workspaceId}/objects/file.bin`,
      });
      const bId = await insertObject({
        db: ctx.current.db,
        workspaceId: fx.b.workspaceId,
        providerId: fx.b.providerId,
        sha256: sha,
        status: 'ready',
        createdAt: new Date('2026-02-01T00:00:00Z'),
        providerObjectKeyHint: `workspaces/${fx.b.workspaceId}/objects/file.bin`,
      });

      await ctx.current.db.execute(RECONCILE_SQL);

      for (const id of [aId, bId]) {
        const row = (await ctx.current.db.execute(sql`
          SELECT status, failure_code FROM platform.storage_objects WHERE id = ${id}
        `)) as unknown as Array<{ status: string; failure_code: string | null }>;
        expect(row[0].status).toBe('ready');
        expect(row[0].failure_code).toBeNull();
      }
    } finally {
      await fx.cleanup();
    }
  });

  test('does NOT demote rows whose status is terminal (pending_upload / failed / deleted)', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const sha = '4'.repeat(64);
      // Terminal-status rows — the dev index excludes them; reconciliation
      // predicate also excludes them.
      const pendingId = await insertObject({
        db: ctx.current.db,
        workspaceId: fx.workspaceId,
        providerId: fx.providerId,
        sha256: sha,
        status: 'pending_upload',
        providerObjectKeyHint: `workspaces/${fx.workspaceId}/objects/pending/file.bin`,
      });
      const failedId = await insertObject({
        db: ctx.current.db,
        workspaceId: fx.workspaceId,
        providerId: fx.providerId,
        sha256: sha,
        status: 'failed',
        providerObjectKeyHint: `workspaces/${fx.workspaceId}/objects/failed/file.bin`,
      });

      await ctx.current.db.execute(RECONCILE_SQL);

      const pending = (await ctx.current.db.execute(sql`
        SELECT status, failure_code FROM platform.storage_objects WHERE id = ${pendingId}
      `)) as unknown as Array<{ status: string; failure_code: string | null }>;
      expect(pending[0].status).toBe('pending_upload');
      expect(pending[0].failure_code).toBeNull();

      const failed = (await ctx.current.db.execute(sql`
        SELECT status, failure_code FROM platform.storage_objects WHERE id = ${failedId}
      `)) as unknown as Array<{ status: string; failure_code: string | null }>;
      expect(failed[0].status).toBe('failed');
      expect(failed[0].failure_code).toBeNull();
    } finally {
      await fx.cleanup();
    }
  });
});
