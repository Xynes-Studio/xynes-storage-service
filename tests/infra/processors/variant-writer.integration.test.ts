/**
 * STORAGE-FU-5 — `PostgresStorageVariantWriter` integration tests.
 *
 * Runs against a real Postgres instance. Soft-skips when the DB is
 * unreachable — matches the STORAGE-FU-2 / STORAGE-FU-3 pattern.
 *
 * Invariants verified:
 *   - Records a variant row scoped to the parent object.
 *   - Refuses to overwrite the original (variant key === parent key).
 *   - Refuses when the parent object does not exist OR belongs to a
 *     different workspace.
 *   - The UNIQUE INDEX `(object_id, variant_kind)` rejects duplicate
 *     recordings.
 *   - The persisted row carries `status='ready'`, the correct
 *     `byteSize`/dimensions, and the `variant_kind` we passed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { and, eq, sql } from 'drizzle-orm';
import {
  connectOrSkip,
  seedWorkspaceFixture,
  seedTwoWorkspaceFixture,
} from '../db/repositories/_db';
import {
  PostgresStorageVariantWriter,
  VARIANT_WRITER_OVERWRITES_ORIGINAL_MESSAGE,
  VARIANT_WRITER_PARENT_NOT_FOUND_MESSAGE,
} from '../../../src/infra/processors/variant-writer';
import { storageObjectVariants, storageObjects } from '../../../src/infra/db/schema';

const conn = await connectOrSkip();

const describeIf = conn ? describe : describe.skip;

afterAll(async () => {
  if (conn) await conn.handle.close();
});

describeIf('PostgresStorageVariantWriter — happy path', () => {
  test('inserts a variant row with status=ready and the correct shape', async () => {
    if (!conn) return;
    const ws = await seedWorkspaceFixture(conn.db);
    try {
      // Seed parent object.
      const objectId = crypto.randomUUID();
      await conn.db.execute(sql`
        INSERT INTO platform.storage_objects
          (id, workspace_id, provider_id, provider_object_key, filename,
           content_type, byte_size, status, purpose, visibility, created_at, updated_at)
        VALUES (
          ${objectId}, ${ws.workspaceId}, ${ws.providerId},
          'workspaces/ws/objects/obj/original.jpg', 'original.jpg',
          'image/jpeg', 1024, 'uploaded', 'cms_media', 'private', now(), now()
        )
      `);

      const writer = new PostgresStorageVariantWriter({ db: conn.db });
      await writer.recordVariant({
        objectId,
        workspaceId: ws.workspaceId,
        role: 'thumbnail_small',
        providerObjectKey: 'workspaces/ws/objects/obj/variants/thumbnail_small.webp',
        contentType: 'image/webp',
        byteSize: 4096,
        width: 240,
        height: 240,
      });

      const rows = await conn.db
        .select()
        .from(storageObjectVariants)
        .where(eq(storageObjectVariants.objectId, objectId));
      expect(rows.length).toBe(1);
      const row = rows[0]!;
      expect(row.variantKind).toBe('thumbnail_small');
      expect(row.providerObjectKey).toBe('workspaces/ws/objects/obj/variants/thumbnail_small.webp');
      expect(row.contentType).toBe('image/webp');
      expect(Number(row.byteSize)).toBe(4096);
      expect(row.width).toBe(240);
      expect(row.height).toBe(240);
      expect(row.status).toBe('ready');
      expect(row.readyAt).not.toBeNull();
    } finally {
      await ws.cleanup();
    }
  });

  test('persists durationSeconds as durationMs (milliseconds)', async () => {
    if (!conn) return;
    const ws = await seedWorkspaceFixture(conn.db);
    try {
      const objectId = crypto.randomUUID();
      await conn.db.execute(sql`
        INSERT INTO platform.storage_objects
          (id, workspace_id, provider_id, provider_object_key, filename,
           content_type, byte_size, status, purpose, visibility, created_at, updated_at)
        VALUES (
          ${objectId}, ${ws.workspaceId}, ${ws.providerId},
          'workspaces/ws/objects/obj/original.mp4', 'original.mp4',
          'video/mp4', 1024, 'uploaded', 'cms_media', 'private', now(), now()
        )
      `);
      const writer = new PostgresStorageVariantWriter({ db: conn.db });
      await writer.recordVariant({
        objectId,
        workspaceId: ws.workspaceId,
        role: 'transcode_h264',
        providerObjectKey: 'workspaces/ws/objects/obj/variants/transcode_h264.mp4',
        contentType: 'video/mp4',
        byteSize: 65536,
        width: 1280,
        height: 720,
        durationSeconds: 12.5,
      });
      const rows = await conn.db
        .select()
        .from(storageObjectVariants)
        .where(eq(storageObjectVariants.objectId, objectId));
      expect(rows[0]!.durationMs).toBe(12500);
    } finally {
      await ws.cleanup();
    }
  });

  test('omits durationMs when durationSeconds is not provided', async () => {
    if (!conn) return;
    const ws = await seedWorkspaceFixture(conn.db);
    try {
      const objectId = crypto.randomUUID();
      await conn.db.execute(sql`
        INSERT INTO platform.storage_objects
          (id, workspace_id, provider_id, provider_object_key, filename,
           content_type, byte_size, status, purpose, visibility, created_at, updated_at)
        VALUES (
          ${objectId}, ${ws.workspaceId}, ${ws.providerId},
          'workspaces/ws/objects/obj/original.png', 'original.png',
          'image/png', 1024, 'uploaded', 'cms_media', 'private', now(), now()
        )
      `);
      const writer = new PostgresStorageVariantWriter({ db: conn.db });
      await writer.recordVariant({
        objectId,
        workspaceId: ws.workspaceId,
        role: 'preview_medium',
        providerObjectKey: 'workspaces/ws/objects/obj/variants/preview_medium.webp',
        contentType: 'image/webp',
        byteSize: 8192,
      });
      const rows = await conn.db
        .select()
        .from(storageObjectVariants)
        .where(eq(storageObjectVariants.objectId, objectId));
      expect(rows[0]!.durationMs).toBeNull();
    } finally {
      await ws.cleanup();
    }
  });
});

describeIf('PostgresStorageVariantWriter — original protection', () => {
  test('refuses when the variant key matches the parent providerObjectKey', async () => {
    if (!conn) return;
    const ws = await seedWorkspaceFixture(conn.db);
    try {
      const objectId = crypto.randomUUID();
      const parentKey = 'workspaces/ws/objects/obj/original.jpg';
      await conn.db.execute(sql`
        INSERT INTO platform.storage_objects
          (id, workspace_id, provider_id, provider_object_key, filename,
           content_type, byte_size, status, purpose, visibility, created_at, updated_at)
        VALUES (
          ${objectId}, ${ws.workspaceId}, ${ws.providerId},
          ${parentKey}, 'original.jpg',
          'image/jpeg', 1024, 'uploaded', 'cms_media', 'private', now(), now()
        )
      `);
      const writer = new PostgresStorageVariantWriter({ db: conn.db });
      await expect(
        writer.recordVariant({
          objectId,
          workspaceId: ws.workspaceId,
          role: 'thumbnail_small',
          providerObjectKey: parentKey, // SAME as parent — refusal expected
          contentType: 'image/jpeg',
          byteSize: 1024,
        }),
      ).rejects.toThrow(VARIANT_WRITER_OVERWRITES_ORIGINAL_MESSAGE);
      // Nothing was inserted.
      const rows = await conn.db
        .select()
        .from(storageObjectVariants)
        .where(eq(storageObjectVariants.objectId, objectId));
      expect(rows.length).toBe(0);
    } finally {
      await ws.cleanup();
    }
  });
});

describeIf('PostgresStorageVariantWriter — workspace scoping', () => {
  test('refuses when the object id does not exist', async () => {
    if (!conn) return;
    const ws = await seedWorkspaceFixture(conn.db);
    try {
      const writer = new PostgresStorageVariantWriter({ db: conn.db });
      await expect(
        writer.recordVariant({
          objectId: crypto.randomUUID(),
          workspaceId: ws.workspaceId,
          role: 'thumbnail_small',
          providerObjectKey: 'workspaces/ws/objects/obj/variants/x.webp',
          contentType: 'image/webp',
          byteSize: 1,
        }),
      ).rejects.toThrow(VARIANT_WRITER_PARENT_NOT_FOUND_MESSAGE);
    } finally {
      await ws.cleanup();
    }
  });

  test('refuses when the object exists but belongs to a different workspace', async () => {
    if (!conn) return;
    const both = await seedTwoWorkspaceFixture(conn.db);
    try {
      const objectId = crypto.randomUUID();
      // Object lives in workspace A.
      await conn.db.execute(sql`
        INSERT INTO platform.storage_objects
          (id, workspace_id, provider_id, provider_object_key, filename,
           content_type, byte_size, status, purpose, visibility, created_at, updated_at)
        VALUES (
          ${objectId}, ${both.a.workspaceId}, ${both.a.providerId},
          'workspaces/a/objects/obj/original.jpg', 'original.jpg',
          'image/jpeg', 1024, 'uploaded', 'cms_media', 'private', now(), now()
        )
      `);
      const writer = new PostgresStorageVariantWriter({ db: conn.db });
      // Caller claims it belongs to workspace B → not found envelope.
      await expect(
        writer.recordVariant({
          objectId,
          workspaceId: both.b.workspaceId,
          role: 'thumbnail_small',
          providerObjectKey: 'workspaces/a/objects/obj/variants/thumbnail_small.webp',
          contentType: 'image/webp',
          byteSize: 1024,
        }),
      ).rejects.toThrow(VARIANT_WRITER_PARENT_NOT_FOUND_MESSAGE);

      // Nothing was inserted.
      const rows = await conn.db
        .select()
        .from(storageObjectVariants)
        .where(eq(storageObjectVariants.objectId, objectId));
      expect(rows.length).toBe(0);
    } finally {
      await both.cleanup();
    }
  });
});

describeIf('PostgresStorageVariantWriter — idempotency', () => {
  test('duplicate (object_id, variant_kind) triggers a unique-constraint violation', async () => {
    if (!conn) return;
    const ws = await seedWorkspaceFixture(conn.db);
    try {
      const objectId = crypto.randomUUID();
      await conn.db.execute(sql`
        INSERT INTO platform.storage_objects
          (id, workspace_id, provider_id, provider_object_key, filename,
           content_type, byte_size, status, purpose, visibility, created_at, updated_at)
        VALUES (
          ${objectId}, ${ws.workspaceId}, ${ws.providerId},
          'workspaces/ws/objects/obj/original.jpg', 'original.jpg',
          'image/jpeg', 1024, 'uploaded', 'cms_media', 'private', now(), now()
        )
      `);
      const writer = new PostgresStorageVariantWriter({ db: conn.db });
      await writer.recordVariant({
        objectId,
        workspaceId: ws.workspaceId,
        role: 'thumbnail_small',
        providerObjectKey: 'workspaces/ws/objects/obj/variants/thumbnail_small.webp',
        contentType: 'image/webp',
        byteSize: 4096,
      });
      await expect(
        writer.recordVariant({
          objectId,
          workspaceId: ws.workspaceId,
          role: 'thumbnail_small', // same role => unique violation
          providerObjectKey: 'workspaces/ws/objects/obj/variants/thumbnail_small.webp',
          contentType: 'image/webp',
          byteSize: 4096,
        }),
      ).rejects.toThrow();
      // Still exactly one variant row.
      const rows = await conn.db
        .select()
        .from(storageObjectVariants)
        .where(
          and(
            eq(storageObjectVariants.objectId, objectId),
            eq(storageObjectVariants.variantKind, 'thumbnail_small'),
          ),
        );
      expect(rows.length).toBe(1);
    } finally {
      await ws.cleanup();
    }
  });
});

describeIf('PostgresStorageVariantWriter — soft-delete race (PR #13 Codex P2)', () => {
  test('refuses to record a variant when the parent is soft-deleted (status=deleted)', async () => {
    if (!conn) return;
    const ws = await seedWorkspaceFixture(conn.db);
    try {
      const objectId = crypto.randomUUID();
      // Schema constraint `storage_objects_deleted_consistency` requires
      // `deleted_at IS NOT NULL` when `status='deleted'`.
      await conn.db.execute(sql`
        INSERT INTO platform.storage_objects
          (id, workspace_id, provider_id, provider_object_key, filename,
           content_type, byte_size, status, deleted_at, purpose, visibility, created_at, updated_at)
        VALUES (
          ${objectId}, ${ws.workspaceId}, ${ws.providerId},
          'workspaces/ws/objects/obj/original.jpg', 'original.jpg',
          'image/jpeg', 1024, 'deleted', now(), 'cms_media', 'private', now(), now()
        )
      `);

      const writer = new PostgresStorageVariantWriter({ db: conn.db });
      await expect(
        writer.recordVariant({
          objectId,
          workspaceId: ws.workspaceId,
          role: 'thumbnail_small',
          providerObjectKey: 'workspaces/ws/objects/obj/variants/thumbnail_small.webp',
          contentType: 'image/webp',
          byteSize: 4096,
        }),
      ).rejects.toThrow(VARIANT_WRITER_PARENT_NOT_FOUND_MESSAGE);
      // Nothing was inserted — the variant row count for the soft-deleted
      // parent stays at zero.
      const rows = await conn.db
        .select()
        .from(storageObjectVariants)
        .where(eq(storageObjectVariants.objectId, objectId));
      expect(rows.length).toBe(0);
    } finally {
      await ws.cleanup();
    }
  });

  test('records the variant before deletion, refuses after deletion (race timeline)', async () => {
    if (!conn) return;
    const ws = await seedWorkspaceFixture(conn.db);
    try {
      const objectId = crypto.randomUUID();
      await conn.db.execute(sql`
        INSERT INTO platform.storage_objects
          (id, workspace_id, provider_id, provider_object_key, filename,
           content_type, byte_size, status, purpose, visibility, created_at, updated_at)
        VALUES (
          ${objectId}, ${ws.workspaceId}, ${ws.providerId},
          'workspaces/ws/objects/obj/original.jpg', 'original.jpg',
          'image/jpeg', 1024, 'uploaded', 'cms_media', 'private', now(), now()
        )
      `);
      const writer = new PostgresStorageVariantWriter({ db: conn.db });

      // Pre-deletion: write succeeds.
      await writer.recordVariant({
        objectId,
        workspaceId: ws.workspaceId,
        role: 'thumbnail_small',
        providerObjectKey: 'workspaces/ws/objects/obj/variants/thumbnail_small.webp',
        contentType: 'image/webp',
        byteSize: 4096,
      });

      // Soft-delete the parent (simulates a worker-running-during-deletion race).
      await conn.db.execute(sql`
        UPDATE platform.storage_objects
        SET status = 'deleted', deleted_at = now()
        WHERE id = ${objectId}
      `);

      // Post-deletion: subsequent variant write refused.
      await expect(
        writer.recordVariant({
          objectId,
          workspaceId: ws.workspaceId,
          role: 'preview_medium',
          providerObjectKey: 'workspaces/ws/objects/obj/variants/preview_medium.webp',
          contentType: 'image/webp',
          byteSize: 8192,
        }),
      ).rejects.toThrow(VARIANT_WRITER_PARENT_NOT_FOUND_MESSAGE);

      // The pre-deletion variant still exists (we don't retroactively
      // delete those — the `ON DELETE CASCADE` on a hard delete would
      // handle that, and the soft-delete preserves history per the
      // STORAGE-2 schema).
      const rows = await conn.db
        .select()
        .from(storageObjectVariants)
        .where(eq(storageObjectVariants.objectId, objectId));
      expect(rows.length).toBe(1);
      expect(rows[0]!.variantKind).toBe('thumbnail_small');
    } finally {
      await ws.cleanup();
    }
  });
});

if (!conn) {
  // Loud skip so a CI misconfiguration doesn't silently hide coverage.
  // eslint-disable-next-line no-console
  console.log('[STORAGE-FU-5 variant-writer integration tests] skipped — Postgres not reachable');
}

beforeAll(() => {
  // Sanity-touch storageObjects + storageObjectVariants imports so the
  // file is exercised even when the DB skips the tests.
  void storageObjects;
  void storageObjectVariants;
});
