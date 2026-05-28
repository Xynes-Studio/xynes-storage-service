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
}): Promise<string> {
  const objectId = randomUUID();
  const providerObjectKey =
    params.providerObjectKeyHint ?? `workspaces/${params.workspaceId}/objects/${objectId}/file.bin`;
  // Soft-deleted rows must carry a non-null `deleted_at` per the
  // `storage_objects_deleted_consistency` CHECK from STORAGE-2.
  const deletedAtSql = params.status === 'deleted' ? sql`now()` : sql`NULL`;
  await params.db.execute(sql`
    INSERT INTO platform.storage_objects
      (id, workspace_id, provider_id, provider_object_key, filename, content_type,
       byte_size, sha256, purpose, visibility, status, compression_requested,
       created_at, updated_at, deleted_at)
    VALUES (
      ${objectId}, ${params.workspaceId}, ${params.providerId}, ${providerObjectKey},
      'file.bin', 'application/octet-stream', 1024, ${params.sha256}, 'platform_generic',
      'private', ${params.status}, true, now(), now(), ${deletedAtSql}
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
