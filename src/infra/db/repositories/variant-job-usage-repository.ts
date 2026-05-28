/**
 * STORAGE-FU-2 — Postgres implementation of STORAGE-6 + STORAGE-7
 * variant / processing-job / usage repositories.
 *
 * Workspace scoping invariants:
 *   - Every read / mutate is scoped via either `workspace_id = $ws`
 *     directly (jobs, usage) or via a JOIN to the parent `storage_objects`
 *     row whose `workspace_id` is filtered (variants don't carry their
 *     own workspace column — the canonical migration §STORAGE-2 says
 *     "owned by an object", so workspace scoping for variants ALWAYS
 *     goes through the parent object).
 *
 * STORAGE-7 atomic claim:
 *   - `claimNextQueuedJob` runs a `SELECT … FOR UPDATE SKIP LOCKED`
 *     against the index `storage_processing_jobs_status_scheduled_idx`
 *     so two workers polling the same DB cannot claim the same row.
 *   - The implementation uses one transaction so the row is locked AND
 *     flipped to `running` before the lock is released.
 *
 * Security invariants:
 *   - Mappers strip `error_message` (raw runner output) and
 *     `provider_object_key` (variant rows) from the DTO surface.
 *   - The usage repo JOINs `workspace_storage_providers.provider_kind`
 *     onto each daily row so the handler can attribute cost per
 *     provider, but the response builder strips `providerKind` from
 *     the wire DTO (STORAGE-6 invariant).
 */
import { and, eq, exists, inArray, lte, or, sql } from 'drizzle-orm';
import type { StorageDb } from '../client';
import {
  storageObjectVariants,
  storageObjects,
  storageProcessingJobs,
  storageUsageDaily,
  workspaceStorageProviders,
} from '../schema';
import type {
  StorageObjectVariantRecord,
  StorageProcessingJobRecord,
  StorageProcessingJobRepository,
  StorageUsageDailyRecord,
  StorageVariantRepository,
  StorageUsageRepository,
} from '../../../actions/handlers/objects/types';
import type {
  ClaimedJob,
  EnqueueJobInput,
  MarkJobFailedInput,
  ProcessingJobQueueRepository,
  ProcessingJobType,
} from '../../../actions/handlers/processing/types';
import {
  deriveJobRequired,
  mapProcessingJobRow,
  mapUsageRow,
  mapVariantRow,
  type UsageRowWithProviderKind,
} from './mappers';

const DEFAULT_MAX_ATTEMPTS = 3;

// ── PostgresStorageVariantRepository ──────────────────────────────────────

export class PostgresStorageVariantRepository implements StorageVariantRepository {
  constructor(private readonly db: StorageDb) {}

  async listForObject(input: {
    objectId: string;
    workspaceId: string;
  }): Promise<ReadonlyArray<StorageObjectVariantRecord>> {
    // Variants don't carry their own `workspace_id`. Scope via an
    // EXISTS subquery against the parent object — the parent is the
    // single source of truth for workspace ownership. The subquery is
    // workspace-scoped via the `(workspace_id, id)` index already
    // present on `storage_objects`.
    const rows = await this.db
      .select()
      .from(storageObjectVariants)
      .where(
        and(
          eq(storageObjectVariants.objectId, input.objectId),
          exists(
            this.db
              .select({ ok: sql`1` })
              .from(storageObjects)
              .where(
                and(
                  eq(storageObjects.id, input.objectId),
                  eq(storageObjects.workspaceId, input.workspaceId),
                ),
              ),
          ),
        ),
      );
    return rows.map(mapVariantRow);
  }
}

// ── PostgresStorageProcessingJobRepository (STORAGE-6 read surface) ───────

export class PostgresStorageProcessingJobRepository implements StorageProcessingJobRepository {
  constructor(private readonly db: StorageDb) {}

  async listForObject(input: {
    objectId: string;
    workspaceId: string;
  }): Promise<ReadonlyArray<StorageProcessingJobRecord>> {
    const rows = await this.db
      .select()
      .from(storageProcessingJobs)
      .where(
        and(
          eq(storageProcessingJobs.objectId, input.objectId),
          eq(storageProcessingJobs.workspaceId, input.workspaceId),
        ),
      );
    return rows.map(mapProcessingJobRow);
  }
}

// ── PostgresProcessingJobQueueRepository (STORAGE-7) ──────────────────────

/**
 * SQLSTATE for `unique_violation`. We catch this on the INSERT inside
 * `enqueueBatch` to translate the new STORAGE-FU-2-FU-1 partial unique
 * index violation into the same closed-set `DuplicateActiveJobError`
 * envelope that the in-transaction pre-check raises. Callers see ONE
 * consistent error shape regardless of which layer detected the
 * duplicate.
 */
const PG_UNIQUE_VIOLATION = '23505';

/**
 * Name of the STORAGE-FU-2-FU-1 partial unique index on
 * `platform.storage_processing_jobs (object_id, job_kind) WHERE
 * status IN ('queued', 'running')`. Tracked here so a regression
 * that renames the index in the canonical migration is caught at
 * runtime (the catch block falls back to the column-based check
 * defensively when the constraint name doesn't match, so a rename
 * still translates correctly — but a mismatch is a signal to update
 * this constant).
 */
const FU_1_ACTIVE_JOB_INDEX = 'storage_processing_jobs_active_unique_uidx';

/**
 * Drizzle wraps driver errors and re-throws a plain `Error` whose
 * `cause` is the underlying `PostgresError` from `postgres-js`. The
 * `PostgresError` carries `.code` (SQLSTATE) and `.constraint_name`.
 *
 * Returns `null` when the error doesn't look like a PG error so the
 * caller can fall through and re-throw the original.
 */
interface PgErrorLike {
  readonly code?: string;
  readonly constraint_name?: string;
  readonly table_name?: string;
}
function extractPgError(err: unknown): PgErrorLike | null {
  if (err == null || typeof err !== 'object') return null;
  // Drizzle path: { cause: PostgresError }.
  const cause = (err as { cause?: unknown }).cause;
  if (cause && typeof cause === 'object' && 'code' in cause) {
    return cause as PgErrorLike;
  }
  // Direct path (some drivers don't wrap): the error itself has `.code`.
  if ('code' in err) return err as PgErrorLike;
  return null;
}

/**
 * Thrown by `enqueueBatch` when a non-terminal (`queued` / `running`)
 * row already exists for one of the requested `(objectId, jobType)`
 * pairs. Callers should treat this as an idempotency signal: the prior
 * enqueue is still in flight, no work is lost, and no new row needs
 * to be inserted.
 *
 * Per the STORAGE-7 contract (`ProcessingJobQueueRepository.enqueueBatch`):
 * implementations MUST reject duplicate `(objectId, jobType)` pairs
 * already in the queue UNLESS the existing row is in a terminal state.
 * `failed` / `succeeded` / `cancelled` rows are intentionally allowed
 * to be superseded so retries land.
 *
 * STORAGE-FU-2-FU-1: the same error envelope is now raised when the
 * partial unique index `storage_processing_jobs_active_unique_uidx`
 * rejects a duplicate INSERT under multi-worker race (a narrow window
 * the transactional pre-check cannot cover). Callers see ONE error
 * shape regardless of which layer detected the duplicate.
 *
 * The error message intentionally surfaces only the first colliding
 * pair so a hostile caller cannot probe active jobs via trial-and-error
 * batches. The DB-side variant deliberately reports the colliding pair
 * as the FIRST input pair we attempted to insert (the precise pair
 * the partial unique index rejected is in `err.constraint_name` only,
 * not in the message, by design).
 */
export class DuplicateActiveJobError extends Error {
  public readonly code = 'DUPLICATE_ACTIVE_JOB';
  public readonly statusHint = 409 as const;
  public readonly objectId: string;
  public readonly jobType: string;
  constructor(objectId: string, jobType: string) {
    super(`Active processing job already exists for (${objectId}, ${jobType})`);
    this.name = 'DuplicateActiveJobError';
    this.objectId = objectId;
    this.jobType = jobType;
  }
}

export class PostgresProcessingJobQueueRepository implements ProcessingJobQueueRepository {
  constructor(private readonly db: StorageDb) {}

  async enqueueBatch(
    input: ReadonlyArray<EnqueueJobInput>,
  ): Promise<ReadonlyArray<StorageProcessingJobRecord>> {
    if (input.length === 0) return [];
    // One transaction so:
    //   1. The duplicate-check against currently-active rows
    //      (`queued` / `running`) is consistent with the insert.
    //   2. All-or-nothing batch insert.
    //
    // STORAGE-7 contract (types.ts:140-144) says:
    //   "Implementations MUST reject duplicate `(objectId, jobType)`
    //    pairs already in the queue UNLESS the existing row is in a
    //    terminal state".
    //
    // Two-layer enforcement (defense in depth):
    //   (a) Transaction-level pre-check below — runs a `SELECT … status
    //       IN ('queued','running')` against the requested batch and
    //       raises `DuplicateActiveJobError` BEFORE the INSERT. This
    //       gives the caller a clean closed-set error envelope without
    //       wasting an INSERT round-trip on the obvious case.
    //   (b) STORAGE-FU-2-FU-1 partial unique index
    //       `storage_processing_jobs_active_unique_uidx` — covers the
    //       narrow race window where two workers in different
    //       transactions both pass the pre-check before either INSERTs.
    //       The DB-side rejection is caught below and translated into
    //       the same `DuplicateActiveJobError` envelope so callers see
    //       ONE error shape regardless of detection layer.
    return this.db.transaction(async (tx) => {
      // Build a uniqueness probe over the requested batch. Drizzle's
      // `inArray` would collapse the AND on `(object_id IN ..., job_kind
      // IN ...)` and over-match (it'd reject a row whose pair is NOT
      // in the batch). So we use one OR-combined clause per requested
      // pair. The batch is bounded by the planner (≤ 5 entries today
      // per STORAGE-7) so the WHERE size is trivially small.
      const pairClauses = input.map((job) =>
        and(
          eq(storageProcessingJobs.objectId, job.objectId),
          eq(storageProcessingJobs.jobKind, job.jobType),
        ),
      );
      const combined = pairClauses.reduce(
        (acc, clause) => (acc ? or(acc, clause) : clause),
        undefined as ReturnType<typeof or> | undefined,
      );
      if (combined) {
        const conflicts = await tx
          .select({
            objectId: storageProcessingJobs.objectId,
            jobKind: storageProcessingJobs.jobKind,
          })
          .from(storageProcessingJobs)
          .where(
            and(
              combined,
              // Only active (non-terminal) rows block re-enqueue.
              // `failed` / `succeeded` / `cancelled` rows are
              // intentionally allowed to be superseded.
              inArray(storageProcessingJobs.status, ['queued', 'running']),
            ),
          );
        if (conflicts.length > 0) {
          const c = conflicts[0];
          // Closed-set, redacted error code so callers can branch
          // programmatically. The message intentionally does NOT echo
          // the full conflict list (would let a hostile caller probe
          // active jobs by trial-and-error); it surfaces only the
          // first colliding pair.
          throw new DuplicateActiveJobError(c.objectId, c.jobKind);
        }
      }

      try {
        const inserted = await tx
          .insert(storageProcessingJobs)
          .values(
            input.map((job) => ({
              id: job.id,
              objectId: job.objectId,
              workspaceId: job.workspaceId,
              // DB column: job_kind.
              jobKind: job.jobType,
              status: 'queued' as const,
              attempts: 0,
              scheduledAt: job.scheduledAt,
            })),
          )
          .returning();
        return inserted.map(mapProcessingJobRow);
      } catch (err) {
        // STORAGE-FU-2-FU-1 race-window catch: the partial unique index
        // `storage_processing_jobs_active_unique_uidx` rejected a
        // duplicate `(object_id, job_kind)` INSERT for a row already
        // in `queued` / `running` status. Translate into the same
        // closed-set `DuplicateActiveJobError` the pre-check raises.
        const pg = extractPgError(err);
        if (
          pg?.code === PG_UNIQUE_VIOLATION &&
          // Match either the canonical FU-1 index name, or any unique
          // index on `storage_processing_jobs` whose constraint name is
          // unrecognised (defense in depth — a future rename in the
          // canonical migration still translates correctly).
          (pg.constraint_name === FU_1_ACTIVE_JOB_INDEX ||
            (pg.constraint_name && pg.constraint_name.startsWith('storage_processing_jobs_')))
        ) {
          // We don't know which input pair tripped the index without
          // querying the DB again. Report the FIRST batch entry so the
          // error message is deterministic + doesn't leak the contents
          // of unrelated active jobs.
          const c = input[0];
          throw new DuplicateActiveJobError(c.objectId, c.jobType);
        }
        // Unrelated error — re-throw unchanged so the caller sees the
        // original failure.
        throw err;
      }
    });
  }

  async listForObject(input: {
    objectId: string;
    workspaceId: string;
  }): Promise<ReadonlyArray<StorageProcessingJobRecord>> {
    const rows = await this.db
      .select()
      .from(storageProcessingJobs)
      .where(
        and(
          eq(storageProcessingJobs.objectId, input.objectId),
          eq(storageProcessingJobs.workspaceId, input.workspaceId),
        ),
      );
    return rows.map(mapProcessingJobRow);
  }

  async claimNextQueuedJob(input: {
    now: Date;
    workspaceAllowlist?: ReadonlyArray<string>;
  }): Promise<ClaimedJob | null> {
    // Atomic claim:
    //   SELECT id FROM storage_processing_jobs
    //     WHERE status = 'queued' AND scheduled_at <= now()
    //     [AND workspace_id = ANY($allowlist)]
    //     ORDER BY scheduled_at ASC
    //     LIMIT 1
    //     FOR UPDATE SKIP LOCKED;
    //
    //   UPDATE storage_processing_jobs
    //     SET status = 'running', started_at = now()
    //     WHERE id = $claimedId AND status = 'queued'
    //     RETURNING *;
    //
    // The transaction holds the row lock between SELECT and UPDATE.
    // `SKIP LOCKED` is the Postgres mechanism for safe multi-worker
    // concurrent claims.
    return this.db.transaction(async (tx) => {
      // Build the claim query. `workspaceAllowlist` is parameterised via
      // a uuid[] cast bound through Drizzle's tagged template so even
      // hostile workspace ids cannot inject SQL.
      //
      // NB: `postgres-js` driver's tagged-template binding rejects `Date`
      // objects directly — we pass an ISO string + `::timestamptz` cast
      // so Postgres parses it correctly. Drizzle's typed-column updates
      // (`tx.update(...).set({ scheduledAt: dateObj })`) handle Date
      // coercion automatically, but the raw `sql\`SELECT ... <= ${date}\``
      // path does not.
      //
      // Same caveat for arrays: the driver does NOT auto-convert a JS
      // array to a Postgres array literal via tagged-template binding.
      // We build the `ANY (...)` argument by `sql.join`-ing the uuid
      // values into a `(v1, v2, ...)` list, which the driver binds as
      // individual parameters.
      const nowIso = input.now.toISOString();
      const claimedRows =
        input.workspaceAllowlist && input.workspaceAllowlist.length > 0
          ? ((await tx.execute(sql`
              SELECT id FROM platform.storage_processing_jobs
              WHERE status = 'queued'
                AND scheduled_at <= ${nowIso}::timestamptz
                AND workspace_id IN (${sql.join(
                  input.workspaceAllowlist.map((id) => sql`${id}::uuid`),
                  sql`, `,
                )})
              ORDER BY scheduled_at ASC
              LIMIT 1
              FOR UPDATE SKIP LOCKED
            `)) as unknown as Array<{ id: string }>)
          : ((await tx.execute(sql`
              SELECT id FROM platform.storage_processing_jobs
              WHERE status = 'queued'
                AND scheduled_at <= ${nowIso}::timestamptz
              ORDER BY scheduled_at ASC
              LIMIT 1
              FOR UPDATE SKIP LOCKED
            `)) as unknown as Array<{ id: string }>);

      if (claimedRows.length === 0) return null;
      const jobId = claimedRows[0].id;
      const updated = await tx
        .update(storageProcessingJobs)
        .set({ status: 'running', startedAt: input.now })
        .where(and(eq(storageProcessingJobs.id, jobId), eq(storageProcessingJobs.status, 'queued')))
        .returning();
      if (updated.length === 0) return null;
      const row = updated[0];
      return {
        id: row.id,
        objectId: row.objectId,
        workspaceId: row.workspaceId,
        jobType: row.jobKind as ProcessingJobType,
        required: deriveJobRequired(row.jobKind),
        // Payload is not yet persisted (no column on STORAGE-2 schema).
        // The runner contract from STORAGE-8 receives the parent object
        // record via `JobRunnerContext.object`, so an empty payload is
        // safe today. When a `payload jsonb` column lands, this becomes
        // a straight column projection.
        payload: {},
        attempts: row.attempts,
        // `maxAttempts` is enforced at the worker level; the field is
        // informational on the claim. The worker overrides via
        // `deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS`.
        maxAttempts: DEFAULT_MAX_ATTEMPTS,
      };
    });
  }

  async markSucceeded(input: {
    jobId: string;
    now: Date;
  }): Promise<StorageProcessingJobRecord | null> {
    const updated = await this.db
      .update(storageProcessingJobs)
      .set({
        status: 'succeeded',
        finishedAt: input.now,
        // Clear any stale `errorCode` from a prior failed attempt so a
        // retried-and-succeeded job does not surface a stale failure
        // code to readers of `listForObject` and the STORAGE-6 GET
        // response. Without this, downstream status/reporting logic
        // can mis-classify a successful job as still-errored.
        errorCode: null,
        attempts: sql`${storageProcessingJobs.attempts} + 1`,
      })
      .where(
        and(eq(storageProcessingJobs.id, input.jobId), eq(storageProcessingJobs.status, 'running')),
      )
      .returning();
    return updated.length === 0 ? null : mapProcessingJobRow(updated[0]);
  }

  async markFailed(input: MarkJobFailedInput): Promise<StorageProcessingJobRecord | null> {
    if (!input.terminal && !input.nextScheduledAt) {
      throw new Error('nextScheduledAt is required when terminal=false');
    }
    const updates = input.terminal
      ? {
          status: 'failed' as const,
          finishedAt: input.now,
          errorCode: input.errorCode,
          attempts: sql`${storageProcessingJobs.attempts} + 1`,
        }
      : {
          status: 'queued' as const,
          // Clear startedAt so the next claim starts a fresh attempt
          // window for observability.
          startedAt: null,
          errorCode: input.errorCode,
          scheduledAt: input.nextScheduledAt!,
          attempts: sql`${storageProcessingJobs.attempts} + 1`,
        };
    const updated = await this.db
      .update(storageProcessingJobs)
      .set(updates)
      .where(
        and(eq(storageProcessingJobs.id, input.jobId), eq(storageProcessingJobs.status, 'running')),
      )
      .returning();
    return updated.length === 0 ? null : mapProcessingJobRow(updated[0]);
  }

  async releaseClaimedJob(input: {
    jobId: string;
    nextScheduledAt: Date;
    now: Date;
  }): Promise<StorageProcessingJobRecord | null> {
    const updated = await this.db
      .update(storageProcessingJobs)
      .set({
        status: 'queued',
        startedAt: null,
        scheduledAt: input.nextScheduledAt,
        // `attempts` deliberately NOT incremented — release is not a
        // completed attempt per the STORAGE-7 contract.
      })
      .where(
        and(eq(storageProcessingJobs.id, input.jobId), eq(storageProcessingJobs.status, 'running')),
      )
      .returning();
    return updated.length === 0 ? null : mapProcessingJobRow(updated[0]);
  }

  async requeueFailedForObject(input: {
    objectId: string;
    workspaceId: string;
    now: Date;
  }): Promise<ReadonlyArray<StorageProcessingJobRecord>> {
    // Requeue ONLY terminally-failed rows. Running jobs are owned by
    // a worker and MUST NOT be yanked.
    const updated = await this.db
      .update(storageProcessingJobs)
      .set({
        status: 'queued',
        attempts: 0,
        errorCode: null,
        scheduledAt: input.now,
        startedAt: null,
        finishedAt: null,
      })
      .where(
        and(
          eq(storageProcessingJobs.objectId, input.objectId),
          eq(storageProcessingJobs.workspaceId, input.workspaceId),
          eq(storageProcessingJobs.status, 'failed'),
        ),
      )
      .returning();
    return updated.map(mapProcessingJobRow);
  }
}

// ── PostgresStorageUsageRepository (STORAGE-6) ────────────────────────────

export class PostgresStorageUsageRepository implements StorageUsageRepository {
  constructor(private readonly db: StorageDb) {}

  async readDailyForWorkspace(input: {
    workspaceId: string;
    fromDate: string;
    toDate: string;
  }): Promise<ReadonlyArray<StorageUsageDailyRecord>> {
    // LEFT JOIN: `provider_id` is nullable for workspace-wide aggregate
    // rows. The handler collapses per-provider rows for the wire DTO.
    const rows = await this.db
      .select({
        id: storageUsageDaily.id,
        workspaceId: storageUsageDaily.workspaceId,
        providerId: storageUsageDaily.providerId,
        usageDate: storageUsageDaily.usageDate,
        bytesStored: storageUsageDaily.bytesStored,
        bytesEgress: storageUsageDaily.bytesEgress,
        operationsClassA: storageUsageDaily.operationsClassA,
        operationsClassB: storageUsageDaily.operationsClassB,
        objectCount: storageUsageDaily.objectCount,
        createdAt: storageUsageDaily.createdAt,
        updatedAt: storageUsageDaily.updatedAt,
        providerKind: workspaceStorageProviders.providerKind,
      })
      .from(storageUsageDaily)
      .leftJoin(
        workspaceStorageProviders,
        eq(storageUsageDaily.providerId, workspaceStorageProviders.id),
      )
      .where(
        and(
          eq(storageUsageDaily.workspaceId, input.workspaceId),
          // SQL `BETWEEN` with `date` columns is inclusive on both ends.
          sql`${storageUsageDaily.usageDate} >= ${input.fromDate}::date`,
          lte(storageUsageDaily.usageDate, sql`${input.toDate}::date`),
        ),
      );
    return rows.map((row) => mapUsageRow(row as UsageRowWithProviderKind));
  }
}
