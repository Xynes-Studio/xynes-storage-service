/**
 * STORAGE-FU-2 — integration test helpers.
 *
 * The repository integration suite runs against a REAL Postgres
 * instance. Locally that is the dev Supabase stack on `127.0.0.1:5432`;
 * in CI the `STORAGE_INTEGRATION_DB_URL` env var points at a per-job
 * ephemeral container.
 *
 * Tests SKIP cleanly when the env var is absent so a clean laptop
 * (no docker, no supabase) still passes `bun test`. The skip is loud
 * (one log line per skipped file) so a CI misconfiguration does not
 * silently hide the integration coverage.
 *
 * Each test seeds its own workspace + user fixture (UUIDv7-ish via
 * `crypto.randomUUID`) into `platform.workspaces` + `identity.users`
 * and the canonical `platform.workspace_storage_providers` row, then
 * relies on the `ON DELETE CASCADE` on `workspace_id` to clean up
 * every storage row tree at the end of the test. This keeps tests
 * isolated WITHOUT relying on per-test transactions (Drizzle's
 * `db.transaction()` callbacks don't compose with the repository
 * methods that take a plain `StorageDb`).
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createStorageDb, type StorageDb, type StorageDbClient } from '../../../../src/infra/db';

/**
 * Reads the integration DB URL from env. Falls back to the dev Supabase
 * default — that mirrors `xynes-infra` `.env.dev.local`.
 *
 * Returns `null` when neither the explicit env var nor a reachable
 * Supabase default is available. Tests check for `null` and skip.
 */
export function getIntegrationDbUrl(): string | null {
  const override = process.env.STORAGE_INTEGRATION_DB_URL;
  if (override && override.trim() !== '') return override;
  // Default to the dev Supabase URL used by xynes-infra `.env.dev.local`.
  // Tests skip when this is not reachable (see `connectOrSkip`).
  return 'postgresql://postgres:postgres@127.0.0.1:5432/postgres';
}

export interface IntegrationDb {
  readonly db: StorageDb;
  readonly handle: StorageDbClient;
}

/**
 * Opens a connection and verifies `platform.storage_objects` exists.
 * Returns `null` when the DB is unreachable or the schema is not
 * applied — caller MUST skip the test in that case.
 */
export async function connectOrSkip(): Promise<IntegrationDb | null> {
  const url = getIntegrationDbUrl();
  if (!url) return null;
  let handle: StorageDbClient;
  try {
    handle = createStorageDb(url, { maxConnections: 2 });
    // Lightweight readiness probe — `pg_class.oid` for one of our tables.
    const probe = await handle.db.execute(sql`SELECT to_regclass('platform.storage_objects') AS r`);
    const rows = probe as unknown as Array<{ r: string | null }>;
    if (!rows[0] || rows[0].r === null) {
      await handle.close();
      return null;
    }
    return { db: handle.db, handle };
  } catch {
    return null;
  }
}

export interface IntegrationFixture {
  readonly workspaceId: string;
  readonly userId: string;
  readonly providerId: string;
  readonly cleanup: () => Promise<void>;
}

/**
 * Seed one workspace + user + storage provider row. The cleanup
 * deletes the workspace row, which cascades to every storage_* tree
 * row owned by that workspace.
 */
export async function seedWorkspaceFixture(db: StorageDb): Promise<IntegrationFixture> {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const providerId = randomUUID();
  const slug = `storage-fu2-${workspaceId.slice(0, 8)}`;

  // identity.users first — workspace.created_by FK references it.
  await db.execute(sql`
    INSERT INTO identity.users (id, email, created_at)
    VALUES (${userId}, ${`storage-fu2-${userId}@example.test`}, now())
  `);
  await db.execute(sql`
    INSERT INTO platform.workspaces (id, name, slug, created_by, plan_type, created_at)
    VALUES (${workspaceId}, 'STORAGE-FU-2 fixture', ${slug}, ${userId}, 'free', now())
  `);
  await db.execute(sql`
    INSERT INTO platform.workspace_storage_providers
      (id, workspace_id, provider_kind, display_name, bucket, region, endpoint,
       credential_ref, status, is_default, created_by, created_at, updated_at)
    VALUES (
      ${providerId}, ${workspaceId}, 'r2', 'integration-fixture',
      ${`storage-fu2-${providerId.slice(0, 8)}`}, 'auto',
      'https://example-fixture.r2.cloudflarestorage.com',
      'secret://storage-fu2/r2', 'active', true,
      ${userId}, now(), now()
    )
  `);

  const cleanup = async (): Promise<void> => {
    // Workspace cascade clears storage_* rows. Then drop the user row.
    await db.execute(sql`DELETE FROM platform.workspaces WHERE id = ${workspaceId}`);
    await db.execute(sql`DELETE FROM identity.users WHERE id = ${userId}`);
  };

  return { workspaceId, userId, providerId, cleanup };
}

/**
 * Variant of `seedWorkspaceFixture` that creates TWO workspaces with
 * one storage provider each. Used by cross-workspace-isolation tests.
 */
export async function seedTwoWorkspaceFixture(db: StorageDb): Promise<{
  readonly a: IntegrationFixture;
  readonly b: IntegrationFixture;
  readonly cleanup: () => Promise<void>;
}> {
  const a = await seedWorkspaceFixture(db);
  const b = await seedWorkspaceFixture(db);
  return {
    a,
    b,
    cleanup: async () => {
      await a.cleanup();
      await b.cleanup();
    },
  };
}
