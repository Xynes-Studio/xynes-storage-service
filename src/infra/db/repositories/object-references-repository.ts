/**
 * DEDUP-2 — Postgres implementation of `StorageObjectReferenceRepository`.
 *
 * Backed by `platform.storage_object_references` (created by the DEDUP-1
 * migration `20260528090000_storage_object_references_and_dedup_index.sql`).
 *
 * Workspace scoping invariants:
 *   - Every read / mutate verifies the parent object's
 *     `workspace_id = $ws` BEFORE touching the references row. The DB
 *     FK on `object_id` already binds a reference to a single workspace
 *     (via `storage_objects.workspace_id`), but defense-in-depth: a
 *     cross-workspace probe MUST behave as if the object didn't exist.
 *   - Cross-workspace `addReference` / `removeReference` / `countReferences`
 *     all return their "no-op" outcomes (`inserted: false`,
 *     `remaining: 0`, `0`) without leaking row existence.
 *
 * Composite PK idempotency:
 *   - The DB-side PK `(object_id, owner_kind, owner_id)` makes a duplicate
 *     insert a no-op. The repository uses `ON CONFLICT DO NOTHING` so
 *     duplicate inserts NEVER throw — they return `inserted: false`.
 *
 * Security invariants:
 *   - No raw SQL with string interpolation. Every parameter passes
 *     through Drizzle's parameterised query API.
 *   - The repository NEVER returns the row body; only counts + insertion
 *     status. Callers (the delete handler) decide soft-delete based on
 *     `remaining` only — they never see `created_at` / `owner_id` of
 *     other reference rows.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { StorageDb } from '../client';
import { storageObjectReferences, storageObjects } from '../schema';
import type {
  StorageObjectReferenceOwnerKind,
  StorageObjectReferenceRepository,
} from '../../../actions/handlers/uploads/types';

export class PostgresStorageObjectReferenceRepository implements StorageObjectReferenceRepository {
  constructor(private readonly db: StorageDb) {}

  /**
   * Verify the object exists in the workspace before any mutate. Returns
   * `true` when the parent row is present AND owned by the workspace.
   * Used by `addReference` / `removeReference` as a defense-in-depth
   * guard on top of the FK.
   */
  private async parentExistsForWorkspace(objectId: string, workspaceId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: storageObjects.id })
      .from(storageObjects)
      .where(and(eq(storageObjects.id, objectId), eq(storageObjects.workspaceId, workspaceId)))
      .limit(1);
    return rows.length > 0;
  }

  async addReference(input: {
    objectId: string;
    workspaceId: string;
    ownerKind: StorageObjectReferenceOwnerKind;
    ownerId: string;
  }): Promise<{ readonly inserted: boolean }> {
    // Workspace check: cross-workspace insert is structurally impossible
    // (the FK to `storage_objects` already binds the reference to ONE
    // workspace), but a hostile caller could try to attach a reference
    // to an object that belongs to a different workspace. We refuse by
    // returning `inserted: false` without leaking row existence.
    const ok = await this.parentExistsForWorkspace(input.objectId, input.workspaceId);
    if (!ok) return { inserted: false };

    // `ON CONFLICT DO NOTHING` makes the composite PK enforce idempotency
    // server-side. Drizzle's `onConflictDoNothing` returns an empty
    // result array on conflict (no row mutated); we use that signal to
    // surface `inserted: false`.
    const rows = await this.db
      .insert(storageObjectReferences)
      .values({
        objectId: input.objectId,
        ownerKind: input.ownerKind,
        ownerId: input.ownerId,
      })
      .onConflictDoNothing()
      .returning({ objectId: storageObjectReferences.objectId });

    return { inserted: rows.length > 0 };
  }

  async removeReference(input: {
    objectId: string;
    workspaceId: string;
    ownerKind: StorageObjectReferenceOwnerKind;
    ownerId: string;
  }): Promise<{ readonly remaining: number }> {
    const ok = await this.parentExistsForWorkspace(input.objectId, input.workspaceId);
    if (!ok) return { remaining: 0 };

    // Delete the specific (object_id, owner_kind, owner_id) row.
    // Idempotent: missing rows are a no-op (zero rows deleted).
    await this.db
      .delete(storageObjectReferences)
      .where(
        and(
          eq(storageObjectReferences.objectId, input.objectId),
          eq(storageObjectReferences.ownerKind, input.ownerKind),
          eq(storageObjectReferences.ownerId, input.ownerId),
        ),
      );

    // Re-count remaining references on the object so the caller can
    // decide whether to soft-delete. The count is workspace-scoped via
    // the parent existence check above; the row count itself reads
    // straight from the references table because every row's
    // `object_id` is already pinned to this workspace.
    const countRows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(storageObjectReferences)
      .where(eq(storageObjectReferences.objectId, input.objectId));
    const remaining = countRows[0]?.count ?? 0;
    return { remaining };
  }

  async countReferences(input: { objectId: string; workspaceId: string }): Promise<number> {
    const ok = await this.parentExistsForWorkspace(input.objectId, input.workspaceId);
    if (!ok) return 0;
    const countRows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(storageObjectReferences)
      .where(eq(storageObjectReferences.objectId, input.objectId));
    return countRows[0]?.count ?? 0;
  }
}
