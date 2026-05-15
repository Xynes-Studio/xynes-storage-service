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
import { and, eq } from 'drizzle-orm';
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

    // 1) Workspace ownership + collision check. One SELECT for both
    //    invariants — the parent must (a) exist within the requested
    //    workspace and (b) have a `providerObjectKey` distinct from
    //    the variant's. We deliberately use the parent's recorded key
    //    rather than re-deriving it; the runner has already written
    //    bytes at `input.providerObjectKey`, and we want to be sure
    //    that key isn't shadowing the original.
    const parents = await db
      .select({
        providerObjectKey: storageObjects.providerObjectKey,
      })
      .from(storageObjects)
      .where(
        and(
          eq(storageObjects.id, input.objectId),
          eq(storageObjects.workspaceId, input.workspaceId),
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
