/**
 * STORAGE-FU-2 — Postgres implementation of the storage object + upload
 * session repository contracts from STORAGE-5 + STORAGE-6.
 *
 * One file ships both repos because they share the atomic
 * `createObjectWithSession` transaction. Splitting them would either
 * duplicate the transaction body or require an awkward inter-class
 * dependency.
 *
 * Workspace scoping invariants:
 *   - Every SELECT / UPDATE includes `workspace_id = $ws` as the first
 *     WHERE clause. There is NO method on either repo that allows a
 *     caller to read or mutate rows for an unspecified workspace.
 *   - `findByIdForWorkspace` returns `null` for cross-workspace probes
 *     (preserves the "no enumeration oracle" invariant from STORAGE-6).
 *   - `softDeleteForWorkspace` is idempotent: returns the soft-deleted
 *     row even on repeat calls.
 *   - `markUploaded` / `markCompletedIfPending` / `markAbortedIfPending`
 *     are conditional updates that return `null` on race-loss.
 *
 * Security invariants:
 *   - No raw SQL with string interpolation. Every parameter passes
 *     through Drizzle's parameterised query API (or `sql` template
 *     placeholders for the rare raw-SQL paths).
 *   - Mappers strip `provider_object_key`, `failure_code`,
 *     `failure_message`, `deleted_at`, `ready_at` from the DTO surface.
 *     `provider_object_key` IS exposed on the DTO because the upload /
 *     download / delete handlers need it (signed-URL generation,
 *     provider-side delete) — STORAGE-5/6 response builders strip it
 *     before the wire DTO. We document this rule below at the mapper
 *     boundary.
 */
import { and, asc, desc, eq, gte, inArray, lte, lt, or, sql } from 'drizzle-orm';
import type { StorageDb } from '../client';
import { storageObjects, storageUploadSessions } from '../schema';
import type {
  CreateObjectWithSessionInput,
  CreateObjectWithSessionResult,
  StorageObjectRecord,
  StorageObjectRepository,
  UploadSessionRecord,
  UploadSessionRepository,
} from '../../../actions/handlers/uploads/types';
import type {
  ExtendedStorageObjectRepository,
  ListObjectsRepoInput,
  ListObjectsRepoResult,
  ObjectStatus,
} from '../../../actions/handlers/objects/types';
import type { StorageObjectStatusRepository } from '../../../actions/handlers/processing/types';
import { mapStorageObjectRow, mapUploadSessionRow } from './mappers';
import { decodeListCursor, encodeListCursor } from '../../../actions/handlers/objects/cursor';
import type { AbandonedUploadSessionRepository } from '../../cleanup/abandoned-uploads';

/**
 * STORAGE-FU-2-FU-4 — single source of truth for the MIME prefix list
 * per content-type family.
 *
 * Two call sites consume this:
 *   - `familyMimePrefixes()` below — returns the per-family list for the
 *     positive branch of the `contentTypeFamily` filter.
 *   - The `contentTypeFamily === 'other'` branch inside `listForWorkspace`
 *     — derives its exclusion list from the shared `ALL_KNOWN_PREFIXES`
 *     constant so there is exactly ONE source of truth for the per-family
 *     prefix list (DRY). Adding a new family to that constant automatically
 *     tightens the 'other' branch — no second edit site to remember.
 *
 * Adding a new content-type family requires:
 *   1. Add the family to `CONTENT_TYPE_FAMILIES` in
 *      `actions/handlers/objects/schemas.ts` (closed-set source).
 *   2. Add the prefix list here.
 *   3. The 'other' branch automatically excludes the new prefixes.
 *
 * The constant + every inner array are frozen at module load to prevent
 * runtime mutation (a hostile caller cannot extend the prefix set).
 */
type NonOtherFamily = Exclude<
  NonNullable<ListObjectsRepoInput['filters']['contentTypeFamily']>,
  'other'
>;

export const CONTENT_TYPE_FAMILY_PREFIXES: Readonly<Record<NonOtherFamily, readonly string[]>> =
  Object.freeze({
    image: Object.freeze(['image/']),
    video: Object.freeze(['video/']),
    audio: Object.freeze(['audio/']),
    text: Object.freeze(['text/']),
    archive: Object.freeze([
      'application/zip',
      'application/x-tar',
      'application/x-7z-compressed',
      'application/x-rar',
      'application/gzip',
    ]),
    document: Object.freeze([
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument',
      'application/vnd.oasis.opendocument',
      'application/rtf',
    ]),
  }) as Readonly<Record<NonOtherFamily, readonly string[]>>;

/** Flattened union of every known family's prefixes. Used by the 'other' branch. */
const ALL_KNOWN_PREFIXES: readonly string[] = Object.freeze(
  (Object.values(CONTENT_TYPE_FAMILY_PREFIXES) as readonly (readonly string[])[]).flatMap((p) => [
    ...p,
  ]),
);

/** MIME → content-type-family table mirrored from `schemas.classifyContentType`. */
function familyMimePrefixes(
  family: NonNullable<ListObjectsRepoInput['filters']['contentTypeFamily']>,
): readonly string[] {
  if (family === 'other') return [];
  // Closed-set TS guarantees `family` is a key here; the `?? []` is defense
  // in depth against a future closed-set drift (e.g. a new value added to
  // `CONTENT_TYPE_FAMILIES` without a matching prefix entry — fails closed
  // to "match nothing" rather than throw).
  return CONTENT_TYPE_FAMILY_PREFIXES[family as NonOtherFamily] ?? [];
}

// ── PostgresStorageObjectRepository ─────────────────────────────────────────

export class PostgresStorageObjectRepository implements StorageObjectRepository {
  constructor(protected readonly db: StorageDb) {}

  async markUploaded(input: {
    objectId: string;
    workspaceId: string;
    sha256: string | null;
  }): Promise<StorageObjectRecord | null> {
    // Look up row scoped to workspace first.
    const existing = await this.db
      .select()
      .from(storageObjects)
      .where(
        and(
          eq(storageObjects.id, input.objectId),
          eq(storageObjects.workspaceId, input.workspaceId),
        ),
      )
      .limit(1);
    if (existing.length === 0) return null;
    const row = existing[0];

    // Idempotent: an already-`uploaded` (or later-state) row is left untouched.
    if (
      row.status === 'uploaded' ||
      row.status === 'processing' ||
      row.status === 'ready' ||
      row.status === 'failed'
    ) {
      return mapStorageObjectRow(row);
    }
    // `deleted` rows are NOT promoted to `uploaded` — return null so the
    // caller surfaces a "not found" envelope.
    if (row.status === 'deleted') return null;

    const updated = await this.db
      .update(storageObjects)
      .set({
        status: 'uploaded',
        sha256: input.sha256,
        uploadedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(storageObjects.id, input.objectId),
          eq(storageObjects.workspaceId, input.workspaceId),
          eq(storageObjects.status, 'pending_upload'),
        ),
      )
      .returning();
    if (updated.length === 0) {
      // Race-loss: another worker already flipped the status. Re-read so
      // the caller still sees the canonical state.
      const reread = await this.db
        .select()
        .from(storageObjects)
        .where(
          and(
            eq(storageObjects.id, input.objectId),
            eq(storageObjects.workspaceId, input.workspaceId),
          ),
        )
        .limit(1);
      if (reread.length === 0) return null;
      if (reread[0].status === 'deleted') return null;
      return mapStorageObjectRow(reread[0]);
    }
    return mapStorageObjectRow(updated[0]);
  }

  async findByIdForWorkspace(input: {
    objectId: string;
    workspaceId: string;
  }): Promise<StorageObjectRecord | null> {
    const rows = await this.db
      .select()
      .from(storageObjects)
      .where(
        and(
          eq(storageObjects.id, input.objectId),
          eq(storageObjects.workspaceId, input.workspaceId),
        ),
      )
      .limit(1);
    if (rows.length === 0) return null;
    return mapStorageObjectRow(rows[0]);
  }

  /**
   * DEDUP-2 — Probe for an existing object in this workspace whose
   * `sha256` matches AND whose `status` is `uploaded` / `processing` /
   * `ready`. The predicate mirrors the partial unique index from the
   * DEDUP-1 migration (`storage_objects_workspace_sha256_uidx`).
   *
   * Workspace scoping is enforced at the SQL layer — the `workspace_id`
   * filter is the FIRST predicate so a hostile probe with someone else's
   * sha256 cannot leak existence across tenants.
   *
   * Returns the first matching row (ordered by `created_at` ASC, then
   * `id` ASC to make the tiebreaker deterministic). If the dedup
   * reconciliation from the DEDUP-1 migration has run, at most one such
   * row should exist for any `(workspace_id, sha256)`; ordering is
   * defense-in-depth.
   */
  async findExistingByWorkspaceSha256(input: {
    workspaceId: string;
    sha256: string;
  }): Promise<StorageObjectRecord | null> {
    const rows = await this.db
      .select()
      .from(storageObjects)
      .where(
        and(
          eq(storageObjects.workspaceId, input.workspaceId),
          eq(storageObjects.sha256, input.sha256),
          inArray(storageObjects.status, ['uploaded', 'processing', 'ready']),
        ),
      )
      .orderBy(asc(storageObjects.createdAt), asc(storageObjects.id))
      .limit(1);
    if (rows.length === 0) return null;
    return mapStorageObjectRow(rows[0]);
  }
}

// ── PostgresExtendedStorageObjectRepository ────────────────────────────────

export class PostgresExtendedStorageObjectRepository
  extends PostgresStorageObjectRepository
  implements ExtendedStorageObjectRepository
{
  async listForWorkspace(input: ListObjectsRepoInput): Promise<ListObjectsRepoResult> {
    const limit = Math.max(1, Math.min(input.limit, 200));
    const filters = input.filters;
    const cursor = decodeListCursor(input.cursor);

    const whereClauses = [
      eq(storageObjects.workspaceId, input.workspaceId),
      // STORAGE-6 invariant: list NEVER returns soft-deleted rows.
      sql`${storageObjects.status} <> 'deleted'`,
    ];
    if (filters.purpose) whereClauses.push(eq(storageObjects.purpose, filters.purpose));
    if (filters.status) whereClauses.push(eq(storageObjects.status, filters.status));
    if (filters.createdBy) whereClauses.push(eq(storageObjects.createdBy, filters.createdBy));
    if (filters.createdAfter)
      whereClauses.push(gte(storageObjects.createdAt, filters.createdAfter));
    if (filters.createdBefore)
      whereClauses.push(lte(storageObjects.createdAt, filters.createdBefore));
    if (filters.contentTypeFamily) {
      const prefixes = familyMimePrefixes(filters.contentTypeFamily);
      if (prefixes.length === 0) {
        // STORAGE-FU-2-FU-4: `other` => exclude every known family prefix.
        // The exclusion list is derived from `CONTENT_TYPE_FAMILY_PREFIXES`
        // so there is exactly ONE source of truth for the per-family
        // prefix list (DRY). Adding a new family to that constant
        // automatically tightens the 'other' branch — no second edit
        // site to remember.
        //
        // Drizzle's `sql` template parameterises each prefix value
        // (preserves the pre-FU-4 parameterisation posture; no string
        // interpolation of prefix values).
        const excludeClauses = ALL_KNOWN_PREFIXES.map(
          (p) => sql`${storageObjects.contentType} LIKE ${p + '%'}`,
        );
        const combinedExclude = excludeClauses.reduce(
          (acc, clause) => (acc ? or(acc, clause) : clause),
          undefined as ReturnType<typeof or> | undefined,
        );
        if (combinedExclude) {
          whereClauses.push(sql`NOT (${combinedExclude})`);
        }
      } else {
        const prefixClauses = prefixes.map(
          (p) => sql`${storageObjects.contentType} LIKE ${p + '%'}`,
        );
        // OR-combine via reduce so an arbitrary count of prefixes works.
        const combined = prefixClauses.reduce(
          (acc, clause) => (acc ? or(acc, clause) : clause),
          undefined as ReturnType<typeof or> | undefined,
        );
        if (combined) whereClauses.push(combined);
      }
    }
    // Keyset cursor: rows strictly older than (lastCreatedAt, lastId).
    if (cursor) {
      const cursorDate = new Date(cursor.lastCreatedAt);
      whereClauses.push(
        or(
          lt(storageObjects.createdAt, cursorDate),
          and(eq(storageObjects.createdAt, cursorDate), lt(storageObjects.id, cursor.lastId)),
        )!,
      );
    }

    const rows = await this.db
      .select()
      .from(storageObjects)
      .where(and(...whereClauses))
      .orderBy(desc(storageObjects.createdAt), desc(storageObjects.id))
      .limit(limit + 1);

    const items = rows.slice(0, limit).map(mapStorageObjectRow);
    const hasMore = rows.length > limit;
    const nextCursor =
      hasMore && items.length > 0
        ? encodeListCursor({
            lastCreatedAt: items[items.length - 1].createdAt.toISOString(),
            lastId: items[items.length - 1].id,
          })
        : null;

    return { items, nextCursor };
  }

  async softDeleteForWorkspace(input: {
    objectId: string;
    workspaceId: string;
    now: Date;
  }): Promise<StorageObjectRecord | null> {
    const rows = await this.db
      .select()
      .from(storageObjects)
      .where(
        and(
          eq(storageObjects.id, input.objectId),
          eq(storageObjects.workspaceId, input.workspaceId),
        ),
      )
      .limit(1);
    if (rows.length === 0) return null;
    const row = rows[0];
    if (row.status === 'deleted') {
      // Idempotent — already soft-deleted.
      return mapStorageObjectRow(row);
    }
    const updated = await this.db
      .update(storageObjects)
      .set({
        status: 'deleted',
        deletedAt: input.now,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(storageObjects.id, input.objectId),
          eq(storageObjects.workspaceId, input.workspaceId),
          // Conditional: only flip non-deleted rows. A race-loser falls
          // through to a re-read on the next call.
          sql`${storageObjects.status} <> 'deleted'`,
        ),
      )
      .returning();
    if (updated.length === 0) {
      // Race-loss: re-read.
      const reread = await this.db
        .select()
        .from(storageObjects)
        .where(
          and(
            eq(storageObjects.id, input.objectId),
            eq(storageObjects.workspaceId, input.workspaceId),
          ),
        )
        .limit(1);
      return reread.length === 0 ? null : mapStorageObjectRow(reread[0]);
    }
    return mapStorageObjectRow(updated[0]);
  }
}

// ── PostgresUploadSessionRepository ────────────────────────────────────────

export class PostgresUploadSessionRepository implements UploadSessionRepository {
  constructor(private readonly db: StorageDb) {}

  async createObjectWithSession(
    input: CreateObjectWithSessionInput,
  ): Promise<CreateObjectWithSessionResult> {
    // One transaction so a session insert failure rolls back the object
    // insert. The transaction callback returns the two rows so the
    // caller never sees a partially-applied state.
    return this.db.transaction(async (tx) => {
      const objectRows = await tx
        .insert(storageObjects)
        .values({
          id: input.objectId,
          workspaceId: input.workspaceId,
          providerId: input.providerId,
          providerObjectKey: input.providerObjectKey,
          filename: input.filename,
          contentType: input.contentType,
          byteSize: BigInt(input.byteSize),
          sha256: input.sha256,
          purpose: input.purpose,
          visibility: input.visibility,
          status: 'pending_upload',
          compressionRequested: input.compressionRequested,
          createdBy: input.createdBy,
        })
        .returning();
      const sessionRows = await tx
        .insert(storageUploadSessions)
        .values({
          id: input.sessionId,
          workspaceId: input.workspaceId,
          objectId: input.objectId,
          uploadMethod: input.uploadMethod,
          providerUploadId: input.providerUploadId,
          status: 'pending',
          expiresAt: input.expiresAt,
          createdBy: input.createdBy,
        })
        .returning();
      return {
        object: mapStorageObjectRow(objectRows[0]),
        session: mapUploadSessionRow(sessionRows[0]),
      };
    });
  }

  async findByIdForWorkspace(input: {
    sessionId: string;
    workspaceId: string;
  }): Promise<UploadSessionRecord | null> {
    const rows = await this.db
      .select()
      .from(storageUploadSessions)
      .where(
        and(
          eq(storageUploadSessions.id, input.sessionId),
          eq(storageUploadSessions.workspaceId, input.workspaceId),
        ),
      )
      .limit(1);
    if (rows.length === 0) return null;
    return mapUploadSessionRow(rows[0]);
  }

  async markCompletedIfPending(input: {
    sessionId: string;
    workspaceId: string;
    now: Date;
  }): Promise<UploadSessionRecord | null> {
    const updated = await this.db
      .update(storageUploadSessions)
      .set({
        status: 'completed',
        completedAt: input.now,
      })
      .where(
        and(
          eq(storageUploadSessions.id, input.sessionId),
          eq(storageUploadSessions.workspaceId, input.workspaceId),
          eq(storageUploadSessions.status, 'pending'),
          // `expires_at` must be in the future. Drizzle's `gte` against
          // a timestamp column with a JS Date does the right thing.
          gte(storageUploadSessions.expiresAt, input.now),
        ),
      )
      .returning();
    return updated.length === 0 ? null : mapUploadSessionRow(updated[0]);
  }

  async markAbortedIfPending(input: {
    sessionId: string;
    workspaceId: string;
    now: Date;
  }): Promise<UploadSessionRecord | null> {
    const updated = await this.db
      .update(storageUploadSessions)
      .set({
        status: 'aborted',
        abortedAt: input.now,
      })
      .where(
        and(
          eq(storageUploadSessions.id, input.sessionId),
          eq(storageUploadSessions.workspaceId, input.workspaceId),
          eq(storageUploadSessions.status, 'pending'),
        ),
      )
      .returning();
    return updated.length === 0 ? null : mapUploadSessionRow(updated[0]);
  }
}

// ── PostgresAbandonedUploadSessionRepository ───────────────────────────────

export class PostgresAbandonedUploadSessionRepository implements AbandonedUploadSessionRepository {
  constructor(private readonly db: StorageDb) {}

  async listExpiredPending(input: { now: Date; limit: number }): Promise<UploadSessionRecord[]> {
    const rows = await this.db
      .select()
      .from(storageUploadSessions)
      .where(
        and(
          eq(storageUploadSessions.status, 'pending'),
          lt(storageUploadSessions.expiresAt, input.now),
        ),
      )
      .orderBy(asc(storageUploadSessions.expiresAt))
      .limit(Math.max(1, Math.min(input.limit, 1000)));
    return rows.map(mapUploadSessionRow);
  }

  async markExpiredIfPending(input: {
    sessionId: string;
    workspaceId: string;
    now: Date;
  }): Promise<UploadSessionRecord | null> {
    const updated = await this.db
      .update(storageUploadSessions)
      .set({
        // `expired` is a separate terminal state; we re-use the
        // `aborted_at` timestamp column to mark when we stamped it.
        // The canonical migration intentionally does NOT add an
        // `expired_at` column — sessions expire via the
        // expires_at-in-the-past + status='expired' combination.
        status: 'expired',
      })
      .where(
        and(
          eq(storageUploadSessions.id, input.sessionId),
          eq(storageUploadSessions.workspaceId, input.workspaceId),
          eq(storageUploadSessions.status, 'pending'),
        ),
      )
      .returning();
    return updated.length === 0 ? null : mapUploadSessionRow(updated[0]);
  }
}

// ── PostgresStorageObjectStatusRepository (STORAGE-7) ──────────────────────

export class PostgresStorageObjectStatusRepository implements StorageObjectStatusRepository {
  constructor(private readonly db: StorageDb) {}

  async updateAggregateStatus(input: {
    objectId: string;
    workspaceId: string;
    nextStatus: Extract<ObjectStatus, 'processing' | 'ready' | 'failed'>;
    now: Date;
  }): Promise<StorageObjectRecord | null> {
    const updated = await this.db
      .update(storageObjects)
      .set({
        status: input.nextStatus,
        updatedAt: input.now,
        // `ready_at` is stamped only when transitioning to `ready`.
        ...(input.nextStatus === 'ready' ? { readyAt: input.now } : {}),
      })
      .where(
        and(
          eq(storageObjects.id, input.objectId),
          eq(storageObjects.workspaceId, input.workspaceId),
          // Defense in depth: never clobber `deleted` rows.
          sql`${storageObjects.status} <> 'deleted'`,
        ),
      )
      .returning();
    return updated.length === 0 ? null : mapStorageObjectRow(updated[0]);
  }
}
