/**
 * STORAGE-FU-5 — Postgres-backed `StorageVariantWriter` implementation.
 *
 * Bridges the narrow `StorageVariantWriter` port (consumed by every
 * variant-producing runner) to the `platform.storage_object_variants`
 * Drizzle schema.
 *
 * SECURITY invariants enforced here:
 *   - Originals are sacred. Before INSERT, we re-check the parent
 *     object's `providerObjectKey` and refuse the write if the variant
 *     key matches. The runners' `deriveVariantObjectKey` already
 *     enforces this — this is defense in depth.
 *   - Workspace scoping: the parent object must belong to the requested
 *     `workspaceId`. A mismatch surfaces as a generic "Parent object
 *     not found" error so cross-workspace probes cannot be used as an
 *     existence oracle.
 *   - Soft-deleted parents are invisible (PR #13 Codex P2 fix). A job
 *     that started before the parent was soft-deleted can race past
 *     the worker's pre-execution object check; we re-check
 *     `status <> 'deleted'` here so deleted objects cannot accumulate
 *     fresh variant rows after the fact. The SAME `VARIANT_WRITER_PARENT_NOT_FOUND_MESSAGE`
 *     surfaces for both "doesn't exist" and "soft-deleted" — preserves
 *     the STORAGE-6 "deleted is indistinguishable from never-existed"
 *     invariant.
 *   - INSERT runs `status='ready'` + stamps `ready_at = now()`. Runners
 *     only invoke `recordVariant` AFTER the bytes are committed at the
 *     provider, so a `ready` row is correct.
 *   - The UNIQUE INDEX `(object_id, variant_kind)` enforces idempotency
 *     at the DB level — a duplicate runner invocation surfaces as a
 *     unique-constraint violation. We propagate it as a generic error
 *     so the runner's `runRunnerWithErrorMapping` translates it to
 *     `PROCESSOR_FAILED` (retryable). The worker's dedup at job-claim
 *     time means this only fires on a true race.
 */
import { and, eq, ne } from 'drizzle-orm';
import type { StorageDb } from '../db/client';
import { storageObjectVariants, storageObjects } from '../db/schema';
import type {
  StorageVariantWriter,
  VariantRecord,
} from '../../actions/handlers/processing/runners/ports';

export const VARIANT_WRITER_OVERWRITES_ORIGINAL_MESSAGE =
  'Variant write would overwrite the original object';
export const VARIANT_WRITER_PARENT_NOT_FOUND_MESSAGE = 'Parent object not found for workspace';

export interface PostgresStorageVariantWriterDeps {
  readonly db: StorageDb;
}

export class PostgresStorageVariantWriter implements StorageVariantWriter {
  constructor(private readonly deps: PostgresStorageVariantWriterDeps) {}

  async recordVariant(input: VariantRecord): Promise<void> {
    const { db } = this.deps;

    // 1) Workspace ownership + soft-delete + collision check. ONE SELECT
    //    that filters on `id` + `workspace_id` + `status <> 'deleted'`
    //    so:
    //    (a) parent must exist within the requested workspace,
    //    (b) parent must NOT be soft-deleted (PR #13 Codex P2 — a job
    //        that started before deletion can race past the worker's
    //        pre-execution object check; this is the second line of
    //        defence), and
    //    (c) the parent's recorded `providerObjectKey` must differ
    //        from the variant's (original-protection).
    //    The SAME `VARIANT_WRITER_PARENT_NOT_FOUND_MESSAGE` surfaces
    //    for both (a) and (b) — preserves the STORAGE-6 "deleted is
    //    indistinguishable from never-existed" invariant.
    const parents = await db
      .select({
        providerObjectKey: storageObjects.providerObjectKey,
      })
      .from(storageObjects)
      .where(
        and(
          eq(storageObjects.id, input.objectId),
          eq(storageObjects.workspaceId, input.workspaceId),
          ne(storageObjects.status, 'deleted'),
        ),
      )
      .limit(1);

    const parent = parents[0];
    if (!parent) {
      throw new Error(VARIANT_WRITER_PARENT_NOT_FOUND_MESSAGE);
    }
    if (parent.providerObjectKey === input.providerObjectKey) {
      throw new Error(VARIANT_WRITER_OVERWRITES_ORIGINAL_MESSAGE);
    }

    // 2) Insert the variant row. UNIQUE INDEX
    //    `(object_id, variant_kind)` enforces idempotency: a duplicate
    //    runner invocation surfaces as a unique-constraint violation,
    //    which we let propagate so `runRunnerWithErrorMapping` translates
    //    it to a closed-set runner error.
    await db.insert(storageObjectVariants).values({
      objectId: input.objectId,
      variantKind: input.role,
      providerObjectKey: input.providerObjectKey,
      contentType: input.contentType,
      byteSize: BigInt(input.byteSize),
      width: input.width ?? null,
      height: input.height ?? null,
      durationMs:
        typeof input.durationSeconds === 'number' ? Math.round(input.durationSeconds * 1000) : null,
      status: 'ready',
      readyAt: new Date(),
    });
  }
}
