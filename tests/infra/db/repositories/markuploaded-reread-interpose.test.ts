/**
 * STORAGE-FU-2-FU-5 — Deterministic coverage of the `markUploaded` race-loss
 * re-read branch.
 *
 * Production source: `src/infra/db/repositories/object-and-session-repository.ts`
 *                    lines ~173–195 (the `if (updated.length === 0)` branch
 *                    that re-reads the row after a conditional UPDATE matches
 *                    0 rows).
 *
 * Why this file exists separately from
 * `object-and-session-repository.test.ts`:
 *   The existing `Promise.all` race test in the integration suite above
 *   proves the contract holds under concurrent traffic but cannot tell Bun's
 *   coverage instrumentation WHICH caller took the re-read branch — both
 *   observe a non-null `uploaded` row on success. Plan §18 acceptance
 *   criterion is "Re-read branch is exercised deterministically by a test
 *   that interposes between the initial SELECT and the conditional UPDATE."
 *
 * Approach (test-side only — production code is byte-for-byte unchanged):
 *   Wrap the real `StorageDb` in a `Proxy` that intercepts the FIRST
 *   `update(...)` invocation. The wrapped chainable builder's terminal step
 *   (`.returning()` OR `.then(...)`) is overridden to:
 *     (a) fire a side-effect raw UPDATE / DELETE that flips the row OUT FROM
 *         UNDER the repo's conditional update predicate, then
 *     (b) delegate to the real builder (which now matches 0 rows).
 *   The proxy unhooks itself after the first interpose so the repo's
 *   subsequent SELECT re-read reaches the real driver and observes the
 *   canonical state.
 *
 * Per plan §18 "no production code change" — no `__forTesting__` export is
 * added to the repository file. The Proxy is constructed entirely from
 * `StorageDb`'s public surface (`update`, `select`, `execute`).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { connectOrSkip, seedWorkspaceFixture } from './_db';
import {
  PostgresStorageObjectRepository,
  PostgresUploadSessionRepository,
} from '../../../../src/infra/db/repositories/object-and-session-repository';
import type { IntegrationDb } from './_db';

const ctx: { current: IntegrationDb | null } = { current: null };

beforeAll(async () => {
  ctx.current = await connectOrSkip();
  if (!ctx.current) {
    console.warn(
      '[STORAGE-FU-2-FU-5] DB unreachable; skipping markUploaded re-read interpose tests.',
    );
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

// ─────────────────────────────────────────────────────────────────────────────
// One-shot `update(...)` interposer.
//
// Targets the FIRST call to `db.update(...)`. The returned wrapped builder
// proxies its chain steps (`.set(...)`, `.where(...)`) so the chain stays
// wrapped, and overrides the terminal `.returning()` / `.then(...)` calls to
// fire the `sideEffectSql` against the underlying `db.execute(...)` BEFORE
// awaiting the real builder.
//
// After the first interpose, the proxy unhooks itself so subsequent
// `update(...)` and every other method call (notably the SELECT re-read
// inside `markUploaded`) goes straight to the real driver.
// ─────────────────────────────────────────────────────────────────────────────
function makeOneShotUpdateInterposer(
  realDb: IntegrationDb['db'],
  sideEffectSql: ReturnType<typeof sql>,
): IntegrationDb['db'] {
  let interposed = false;
  let sideEffectFired = false;

  // Builder Proxy handler. Re-used across chain steps so `set(...).where(...)`
  // stays wrapped without re-allocating handlers.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const builderHandler: ProxyHandler<any> = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get(builderTarget: any, builderProp: string | symbol): unknown {
      const original = builderTarget[builderProp];
      // Chain steps — keep returning the wrapped builder.
      if (builderProp === 'set' || builderProp === 'where') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (...chainArgs: unknown[]): any => {
          const next = (original as (...a: unknown[]) => unknown).apply(builderTarget, chainArgs);
          return new Proxy(next as object, builderHandler);
        };
      }
      // Terminal `.returning()` — fire side effect first, then delegate.
      if (builderProp === 'returning') {
        return async (...returningArgs: unknown[]): Promise<unknown> => {
          if (!sideEffectFired) {
            sideEffectFired = true;
            await realDb.execute(sideEffectSql);
          }
          return (original as (...a: unknown[]) => Promise<unknown>).apply(
            builderTarget,
            returningArgs,
          );
        };
      }
      // Drizzle builders are thenable. If the caller awaits the builder
      // directly (without `.returning()`), treat `.then` as terminal.
      if (builderProp === 'then') {
        return async (
          onFulfilled?: (value: unknown) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ): Promise<unknown> => {
          if (!sideEffectFired) {
            sideEffectFired = true;
            await realDb.execute(sideEffectSql);
          }
          return (original as (...a: unknown[]) => unknown).call(
            builderTarget,
            onFulfilled,
            onRejected,
          );
        };
      }
      // Anything else (e.g. internal Drizzle properties) — pass through bound.
      if (typeof original === 'function') {
        return (original as (...a: unknown[]) => unknown).bind(builderTarget);
      }
      return original;
    },
  };

  return new Proxy(realDb, {
    get(target, prop, receiver): unknown {
      if (prop !== 'update' || interposed) {
        return Reflect.get(target, prop, receiver);
      }
      return (...args: unknown[]): unknown => {
        interposed = true;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const realBuilder = (target as any).update(...args);
        return new Proxy(realBuilder, builderHandler);
      };
    },
  });
}

describeIf('STORAGE-FU-2-FU-5 — markUploaded deterministic re-read branch', () => {
  test('re-read sees `uploaded`: returns canonical uploaded row from the re-read path', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const sessionRepo = new PostgresUploadSessionRepository(ctx.current.db);
      const objectId = randomUUID();
      await sessionRepo.createObjectWithSession({
        objectId,
        sessionId: randomUUID(),
        workspaceId: fx.workspaceId,
        providerId: fx.providerId,
        providerObjectKey: 'k',
        filename: 'f.png',
        contentType: 'image/png',
        byteSize: 1,
        sha256: null,
        purpose: 'cms_media',
        visibility: 'private',
        compressionRequested: true,
        uploadMethod: 'single',
        providerUploadId: null,
        expiresAt: new Date(Date.now() + 60_000),
        createdBy: fx.userId,
      });
      // Side effect: flip the row to `uploaded` with a canonical sha256 BEFORE
      // the repo's conditional UPDATE runs. The conditional UPDATE's predicate
      // `eq(status, 'pending_upload')` then matches 0 rows, forcing the
      // re-read branch.
      const canonicalSha = 'c'.repeat(64);
      const interposedDb = makeOneShotUpdateInterposer(
        ctx.current.db,
        sql`UPDATE platform.storage_objects
              SET status = 'uploaded',
                  sha256 = ${canonicalSha},
                  uploaded_at = now()
            WHERE id = ${objectId}`,
      );
      const repo = new PostgresStorageObjectRepository(interposedDb);
      const losingSha = 'l'.repeat(64);
      const out = await repo.markUploaded({
        objectId,
        workspaceId: fx.workspaceId,
        // The repo will try to write `losingSha` via the conditional update
        // — but that update matches 0 rows, so the re-read MUST surface the
        // CANONICAL sha256, NOT the losing worker's sha256. Asserting on the
        // sha256 value differentiates the re-read path from the conditional
        // UPDATE return path.
        sha256: losingSha,
      });
      expect(out).not.toBeNull();
      expect(out!.status).toBe('uploaded');
      expect(out!.sha256).toBe(canonicalSha);
      expect(out!.sha256).not.toBe(losingSha);
    } finally {
      await fx.cleanup();
    }
  });

  test('re-read sees `deleted`: returns null when the row is soft-deleted between SELECT and UPDATE', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const sessionRepo = new PostgresUploadSessionRepository(ctx.current.db);
      const objectId = randomUUID();
      await sessionRepo.createObjectWithSession({
        objectId,
        sessionId: randomUUID(),
        workspaceId: fx.workspaceId,
        providerId: fx.providerId,
        providerObjectKey: 'k',
        filename: 'f.png',
        contentType: 'image/png',
        byteSize: 1,
        sha256: null,
        purpose: 'cms_media',
        visibility: 'private',
        compressionRequested: true,
        uploadMethod: 'single',
        providerUploadId: null,
        expiresAt: new Date(Date.now() + 60_000),
        createdBy: fx.userId,
      });
      // Side effect: soft-delete the row BEFORE the conditional UPDATE.
      // Initial SELECT still observes `pending_upload`; conditional UPDATE
      // matches 0 rows; re-read sees `deleted` → returns null. Exercises the
      // `if (reread[0].status === 'deleted') return null` branch.
      const interposedDb = makeOneShotUpdateInterposer(
        ctx.current.db,
        sql`UPDATE platform.storage_objects
              SET status = 'deleted', deleted_at = now()
            WHERE id = ${objectId}`,
      );
      const repo = new PostgresStorageObjectRepository(interposedDb);
      const out = await repo.markUploaded({
        objectId,
        workspaceId: fx.workspaceId,
        sha256: null,
      });
      expect(out).toBeNull();
    } finally {
      await fx.cleanup();
    }
  });

  test('re-read sees row vanished: returns null when the row is hard-deleted between SELECT and UPDATE', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const sessionRepo = new PostgresUploadSessionRepository(ctx.current.db);
      const objectId = randomUUID();
      await sessionRepo.createObjectWithSession({
        objectId,
        sessionId: randomUUID(),
        workspaceId: fx.workspaceId,
        providerId: fx.providerId,
        providerObjectKey: 'k',
        filename: 'f.png',
        contentType: 'image/png',
        byteSize: 1,
        sha256: null,
        purpose: 'cms_media',
        visibility: 'private',
        compressionRequested: true,
        uploadMethod: 'single',
        providerUploadId: null,
        expiresAt: new Date(Date.now() + 60_000),
        createdBy: fx.userId,
      });
      // Side effect: HARD-delete the row (and the dependent session first to
      // avoid an FK violation). Exercises the defensive
      // `if (reread.length === 0) return null` branch at the bottom of the
      // re-read path. In production this is unreachable because soft-delete is
      // the contract — the branch exists as defense in depth.
      const interposedDb = makeOneShotUpdateInterposer(
        ctx.current.db,
        sql`
          WITH deleted_sessions AS (
            DELETE FROM platform.storage_upload_sessions
             WHERE object_id = ${objectId}
            RETURNING 1
          )
          DELETE FROM platform.storage_objects
           WHERE id = ${objectId}
        `,
      );
      const repo = new PostgresStorageObjectRepository(interposedDb);
      const out = await repo.markUploaded({
        objectId,
        workspaceId: fx.workspaceId,
        sha256: null,
      });
      expect(out).toBeNull();
    } finally {
      await fx.cleanup();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STORAGE-FU-2-FU-5 — Coverage of `PostgresStorageObjectRepository.findByIdForWorkspace`.
//
// The integration suite in `object-and-session-repository.test.ts` exercises
// `PostgresUploadSessionRepository.findByIdForWorkspace` thoroughly but never
// reaches `PostgresStorageObjectRepository.findByIdForWorkspace` (a sibling
// method on the parent class — production callers normally use
// `PostgresExtendedStorageObjectRepository` for richer queries). These three
// tests fill the gap so the per-file coverage report on
// `object-and-session-repository.ts` reflects every executable branch.
// ─────────────────────────────────────────────────────────────────────────────
describeIf('STORAGE-FU-2-FU-5 — PostgresStorageObjectRepository.findByIdForWorkspace', () => {
  test('returns the workspace-scoped object record by id', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const sessionRepo = new PostgresUploadSessionRepository(ctx.current.db);
      const repo = new PostgresStorageObjectRepository(ctx.current.db);
      const objectId = randomUUID();
      await sessionRepo.createObjectWithSession({
        objectId,
        sessionId: randomUUID(),
        workspaceId: fx.workspaceId,
        providerId: fx.providerId,
        providerObjectKey: 'k',
        filename: 'f.png',
        contentType: 'image/png',
        byteSize: 42,
        sha256: null,
        purpose: 'cms_media',
        visibility: 'private',
        compressionRequested: true,
        uploadMethod: 'single',
        providerUploadId: null,
        expiresAt: new Date(Date.now() + 60_000),
        createdBy: fx.userId,
      });
      const out = await repo.findByIdForWorkspace({
        objectId,
        workspaceId: fx.workspaceId,
      });
      expect(out).not.toBeNull();
      expect(out!.id).toBe(objectId);
      expect(out!.workspaceId).toBe(fx.workspaceId);
      expect(out!.byteSize).toBe(42);
    } finally {
      await fx.cleanup();
    }
  });

  test('returns null for an unknown object id', async () => {
    if (!ctx.current) return;
    const fx = await seedWorkspaceFixture(ctx.current.db);
    try {
      const repo = new PostgresStorageObjectRepository(ctx.current.db);
      const out = await repo.findByIdForWorkspace({
        objectId: randomUUID(),
        workspaceId: fx.workspaceId,
      });
      expect(out).toBeNull();
    } finally {
      await fx.cleanup();
    }
  });

  test('returns null for a cross-workspace probe (workspace scoping)', async () => {
    if (!ctx.current) return;
    const fxA = await seedWorkspaceFixture(ctx.current.db);
    const fxB = await seedWorkspaceFixture(ctx.current.db);
    try {
      const sessionRepo = new PostgresUploadSessionRepository(ctx.current.db);
      const repo = new PostgresStorageObjectRepository(ctx.current.db);
      const objectId = randomUUID();
      await sessionRepo.createObjectWithSession({
        objectId,
        sessionId: randomUUID(),
        workspaceId: fxA.workspaceId,
        providerId: fxA.providerId,
        providerObjectKey: 'k',
        filename: 'f.png',
        contentType: 'image/png',
        byteSize: 1,
        sha256: null,
        purpose: 'cms_media',
        visibility: 'private',
        compressionRequested: true,
        uploadMethod: 'single',
        providerUploadId: null,
        expiresAt: new Date(Date.now() + 60_000),
        createdBy: fxA.userId,
      });
      // Query workspace B for workspace A's object id → must return null
      // (no enumeration oracle).
      const denied = await repo.findByIdForWorkspace({
        objectId,
        workspaceId: fxB.workspaceId,
      });
      expect(denied).toBeNull();
      // Sanity: workspace A still sees its own row.
      const allowed = await repo.findByIdForWorkspace({
        objectId,
        workspaceId: fxA.workspaceId,
      });
      expect(allowed).not.toBeNull();
      expect(allowed!.id).toBe(objectId);
    } finally {
      await fxA.cleanup();
      await fxB.cleanup();
    }
  });
});
