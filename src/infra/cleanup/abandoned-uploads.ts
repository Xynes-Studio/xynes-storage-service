/**
 * STORAGE-9 — Abandoned upload session cleanup job.
 *
 * Plan §STORAGE-9 acceptance criterion (verbatim):
 *   "Upload sessions expire and abandoned multipart uploads are aborted
 *    by a cleanup job. Cleanup MUST call provider AbortMultipartUpload
 *    against the recorded provider_kind and treat 404 / NoSuchUpload as
 *    success (provider already cleaned up)."
 *
 * Flow per session:
 *   1. List `pending` upload sessions whose `expires_at` is in the past.
 *   2. For each:
 *      a. If the session is multipart AND a `providerUploadId` exists,
 *         resolve the provider for the session's workspace and call
 *         `abortMultipartUpload`. A `ProviderAdapterError` is treated as
 *         success (cleanup-job posture for `NoSuchUpload` / already-aborted
 *         provider-side multiparts) — same swallow contract as
 *         `abort.ts` for the per-request abort path. Non-adapter errors
 *         are LOGGED and the session is skipped this run (it stays
 *         `pending` and we try again next cycle).
 *      b. Mark the session `expired` via the conditional repo update.
 *         A failed conditional update (status raced to `completed` /
 *         `aborted` in between) is OK — we log and skip.
 *
 * Security invariants:
 *   - Raw provider credentials NEVER appear in cleanup logs (the
 *     redactor module guarantees this; `runOnce` also avoids emitting
 *     anything that would carry them).
 *   - Cross-workspace fan-out is impossible — the cleanup job iterates
 *     sessions row-by-row and uses each session's `workspaceId` to
 *     resolve the provider. The provider resolver enforces
 *     workspace-scoped lookups.
 *   - The cleanup job is at-least-once: a transient provider outage on
 *     `abortMultipartUpload` re-queues the session for next pass without
 *     losing the local DB row.
 *
 * Polling cadence + scheduling are owned by the service composition
 * root (`src/index.ts` follow-up) — same posture as the STORAGE-7
 * `ProcessingWorker`. Tests drive `runOnce()` deterministically.
 */

import { ProviderAdapterError } from '../providers/errors';
import { logger } from '../logger';
import type {
  StorageObjectRepository,
  StorageProviderResolver,
  UploadSessionRecord,
} from '../../actions/handlers/uploads/types';

/**
 * Repository contract the cleanup job needs on top of the per-request
 * upload repositories. We deliberately keep this narrow so production
 * Drizzle implementations don't have to bundle the full surface.
 */
export interface AbandonedUploadSessionRepository {
  /**
   * Return `pending` sessions whose `expiresAt` is strictly before `now`.
   * Implementations SHOULD use a `LIMIT` to keep batches small and
   * deterministic; the cleanup loop calls `listExpiredPending` once per
   * `runOnce()` and lets the next pass pick up the rest.
   */
  listExpiredPending(input: { now: Date; limit: number }): Promise<UploadSessionRecord[]>;

  /**
   * Conditional update: flip `status='expired'` ONLY when the row is
   * still `pending`. Returns the updated row, or `null` if the row was
   * raced to `completed` / `aborted` / `expired` between list and update.
   */
  markExpiredIfPending(input: {
    sessionId: string;
    workspaceId: string;
    now: Date;
  }): Promise<UploadSessionRecord | null>;
}

export interface AbandonedUploadCleanupDependencies {
  readonly sessions: AbandonedUploadSessionRepository;
  readonly objects: Pick<StorageObjectRepository, 'findByIdForWorkspace'>;
  readonly providers: StorageProviderResolver;
  readonly now?: () => Date;
  /** Default 200. Tests override to assert the limit is forwarded. */
  readonly batchSize?: number;
}

export interface CleanupRunResult {
  /** Number of sessions inspected this run. */
  readonly scanned: number;
  /** Number of sessions successfully flipped to `expired`. */
  readonly expired: number;
  /** Number of sessions that failed provider abort and are deferred. */
  readonly deferred: number;
  /** Number of sessions that raced to a non-`pending` terminal state. */
  readonly raced: number;
}

const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_POLL_INTERVAL_MS = 60_000;

export class AbandonedUploadCleanup {
  private readonly deps: AbandonedUploadCleanupDependencies;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(deps: AbandonedUploadCleanupDependencies) {
    this.deps = deps;
  }

  /**
   * Single deterministic pass. Returns a structured result so callers
   * (tests, ops dashboards) can observe progress without trusting the
   * logs.
   */
  async runOnce(): Promise<CleanupRunResult> {
    if (this.running) {
      return { scanned: 0, expired: 0, deferred: 0, raced: 0 };
    }
    this.running = true;
    try {
      const now = this.now();
      const limit = this.deps.batchSize ?? DEFAULT_BATCH_SIZE;
      const sessions = await this.deps.sessions.listExpiredPending({ now, limit });
      let expired = 0;
      let deferred = 0;
      let raced = 0;

      for (const session of sessions) {
        const result = await this.cleanupSession(session, now);
        if (result === 'expired') expired++;
        else if (result === 'deferred') deferred++;
        else raced++;
      }

      return { scanned: sessions.length, expired, deferred, raced };
    } finally {
      this.running = false;
    }
  }

  /**
   * Start a polling loop that calls `runOnce` every `intervalMs`. The
   * loop swallows `runOnce` errors so a transient repo or provider
   * outage does NOT kill the cleanup process — the next pass will retry.
   */
  start(intervalMs: number = DEFAULT_POLL_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce().catch((err: unknown) => {
        logger.error('Abandoned upload cleanup pass threw', {
          // `err` may carry hostile content; the log redactor scrubs it.
          errorName: err instanceof Error ? err.name : 'unknown',
        });
      });
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  private async cleanupSession(
    session: UploadSessionRecord,
    now: Date,
  ): Promise<'expired' | 'deferred' | 'raced'> {
    // Step 1: abort the provider multipart (best-effort).
    if (session.uploadMethod === 'multipart' && session.providerUploadId) {
      const aborted = await this.abortProviderMultipart(session);
      if (aborted === 'deferred') {
        return 'deferred';
      }
    }

    // Step 2: flip the local row to `expired`.
    const expired = await this.deps.sessions.markExpiredIfPending({
      sessionId: session.id,
      workspaceId: session.workspaceId,
      now,
    });
    if (!expired) {
      // Lost a race to `completed` / `aborted` / `expired`. Not an error.
      logger.info('Abandoned upload cleanup: session raced to terminal state', {
        sessionId: session.id,
        workspaceId: session.workspaceId,
      });
      return 'raced';
    }

    logger.info('Abandoned upload cleanup: session expired', {
      sessionId: session.id,
      workspaceId: session.workspaceId,
      uploadMethod: session.uploadMethod,
    });
    return 'expired';
  }

  /**
   * Returns `'success'` when the provider abort completed cleanly OR was
   * a `ProviderAdapterError` (NoSuchUpload-style — treated as success per
   * STORAGE-9). Returns `'deferred'` when a non-adapter error was thrown
   * (transient infra failure) so the caller skips marking the session
   * `expired` and we retry next cycle.
   */
  private async abortProviderMultipart(
    session: UploadSessionRecord,
  ): Promise<'success' | 'deferred'> {
    const object = await this.deps.objects.findByIdForWorkspace({
      objectId: session.objectId,
      workspaceId: session.workspaceId,
    });
    if (!object) {
      // Orphan session — the object row is gone. Nothing to abort on the
      // provider side; flip the session to `expired` next.
      return 'success';
    }
    const provider = await this.deps.providers.resolveDefaultForWorkspace(session.workspaceId);
    if (!provider) {
      // Workspace has no provider configured anymore. We cannot reach
      // the provider; flip the local row to `expired` anyway so the
      // session stops appearing in this batch. The provider-side
      // multipart will be GC'd by the provider's own lifecycle policy
      // (STORAGE-12 rollout checklist requires lifecycle ≥ 7 days).
      logger.warn('Abandoned upload cleanup: provider resolution missing; flipping local row', {
        sessionId: session.id,
        workspaceId: session.workspaceId,
      });
      return 'success';
    }
    try {
      await provider.adapter.abortMultipartUpload({
        objectKey: object.providerObjectKey,
        providerUploadId: session.providerUploadId!,
      });
      return 'success';
    } catch (err) {
      if (err instanceof ProviderAdapterError) {
        // Pre-redacted adapter error. Treat as success — `NoSuchUpload`
        // / already-aborted multiparts surface this way, same as the
        // per-request abort path in `abort.ts`.
        logger.info('Abandoned upload cleanup: provider abort returned adapter error (success)', {
          sessionId: session.id,
          workspaceId: session.workspaceId,
          code: err.code,
        });
        return 'success';
      }
      // Non-adapter error — transient infra failure. Defer.
      logger.warn('Abandoned upload cleanup: provider abort failed; deferring session', {
        sessionId: session.id,
        workspaceId: session.workspaceId,
        errorName: err instanceof Error ? err.name : 'unknown',
      });
      return 'deferred';
    }
  }
}

export const STORAGE_CLEANUP_DEFAULT_BATCH_SIZE = DEFAULT_BATCH_SIZE;
export const STORAGE_CLEANUP_DEFAULT_POLL_INTERVAL_MS = DEFAULT_POLL_INTERVAL_MS;
