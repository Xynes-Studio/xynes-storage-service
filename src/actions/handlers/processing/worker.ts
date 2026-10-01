/**
 * STORAGE-7 — processing worker engine.
 *
 * The worker polls the queue, claims `queued` jobs atomically, runs
 * them via the per-`jobType` `JobRunner` registry, applies retry /
 * dead-letter logic, and updates the parent object's aggregate status
 * after each terminal transition.
 *
 * Concurrency model:
 *   - Global cap: `maxConcurrent` (default 4) concurrent jobs.
 *   - Per-workspace cap: `maxConcurrentPerWorkspace` (default 2) so a
 *     single busy workspace cannot starve siblings.
 *   - `runOnce()` drives one drain pass — exposed for deterministic
 *     tests. `start()` runs an interval loop.
 *   - Scan jobs finish and persist first within each batch. Every non-scan
 *     runner checks persisted scan success, including across workers.
 *     Pending scans release native claims without consuming attempts.
 *
 * Retry policy:
 *   - On a non-retryable failure → terminal `failed`.
 *   - On a retryable failure AND `attempts < maxAttempts` → requeue
 *     with `now + retryBackoffSeconds`.
 *   - On a retryable failure AND `attempts >= maxAttempts` → terminal
 *     `failed` (dead-lettered).
 *   - On a `RunnerNotImplementedError` (no runner registered for the
 *     job type) → required jobs go terminal `failed` (RUNNER_MISSING);
 *     non-required jobs retry-then-dead-letter (so we don't ruin an
 *     object because a best-effort thumbnail runner hasn't shipped).
 *
 * Aggregate update:
 *   - Re-fetched job list -> `computeAggregateStatus(jobs)` ->
 *     `updateAggregateStatus(...)`. If the object is `deleted`, the
 *     status repo MUST return null and we skip the flip.
 *
 * SECURITY: the worker NEVER logs raw provider config, raw credentials,
 * raw provider error envelopes, or signed URLs. Runner failures surface
 * as opaque `errorCode` strings (e.g. `RUNNER_THREW`, `RUNNER_MISSING`,
 * `RUNNER_FAILED`) — runners themselves are responsible for redacting
 * provider-side details before returning.
 */
import { computeAggregateStatus } from './aggregator';
import { getScanValidationState, type ScanValidationState } from './scan-gate';
import { isFinalizedSource } from '../uploads/finalized-source';
import type {
  ClaimedJob,
  JobRunner,
  ProcessingWorkerDependencies,
  StorageProcessingJobRecord,
} from './types';

export interface WorkerRunStats {
  readonly attempted: number;
  readonly succeeded: number;
  readonly retried: number;
  readonly failed: number;
  readonly skipped: number;
}

const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_MAX_PER_WORKSPACE = 2;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_SECONDS = 60;

export class ProcessingWorker {
  private readonly deps: ProcessingWorkerDependencies;
  private readonly maxConcurrent: number;
  private readonly maxPerWorkspace: number;
  private readonly maxAttempts: number;
  private readonly backoffSeconds: number;
  private readonly now: () => Date;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: ProcessingWorkerDependencies) {
    this.deps = deps;
    this.maxConcurrent = deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.maxPerWorkspace = deps.maxConcurrentPerWorkspace ?? DEFAULT_MAX_PER_WORKSPACE;
    this.maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.backoffSeconds = deps.retryBackoffSeconds ?? DEFAULT_BACKOFF_SECONDS;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Drain one batch — claim up to `maxConcurrent` jobs, run them in
   * parallel respecting the per-workspace cap, then return.
   *
   * Returns when no more jobs can be claimed (either the queue is empty
   * or every workspace allowlist is full).
   */
  async runOnce(): Promise<WorkerRunStats> {
    const claimed: ClaimedJob[] = [];
    const perWorkspaceCount = new Map<string, number>();

    let stats: WorkerRunStats = {
      attempted: 0,
      succeeded: 0,
      retried: 0,
      failed: 0,
      skipped: 0,
    };

    // Claim phase: keep claiming until we either hit `maxConcurrent` or
    // the queue starves.
    while (claimed.length < this.maxConcurrent) {
      // Workspaces that have spare per-workspace slots — those are the
      // only ones we'll accept claims for. We can't pre-filter at the
      // repo layer without first knowing what's queued, so we accept the
      // claim and release on the cap path if the workspace is at
      // capacity. `releaseClaimedJob` MUST NOT count as an attempt — a
      // flow-controlled job is not a job that has been tried.
      const next = await this.deps.queue.claimNextQueuedJob({ now: this.now() });
      if (!next) break;
      const current = perWorkspaceCount.get(next.workspaceId) ?? 0;
      if (current >= this.maxPerWorkspace) {
        // Per-workspace cap hit — release the claim with a tiny backoff
        // so another worker (or this worker on the next pass) picks it
        // up. The release path leaves `attempts` untouched.
        stats = { ...stats, skipped: stats.skipped + 1 };
        await this.deps.queue.releaseClaimedJob({
          jobId: next.id,
          nextScheduledAt: new Date(this.now().getTime() + 1_000),
          now: this.now(),
        });
        continue;
      }
      perWorkspaceCount.set(next.workspaceId, current + 1);
      claimed.push(next);
    }

    if (claimed.length === 0) return stats;

    // Persist scan results first, even if a native job was claimed ahead of
    // its scan. Other workers' running scans are handled by the gate below.
    const scans = await Promise.all(
      claimed.filter((job) => job.jobType === 'scan_validation').map((job) => this.runClaimed(job)),
    );
    const native = await Promise.all(
      claimed.filter((job) => job.jobType !== 'scan_validation').map((job) => this.runClaimed(job)),
    );
    const results = [...scans, ...native];

    for (const r of results) {
      stats = {
        ...stats,
        attempted: stats.attempted + (r === 'skipped' ? 0 : 1),
        succeeded: stats.succeeded + (r === 'succeeded' ? 1 : 0),
        retried: stats.retried + (r === 'retried' ? 1 : 0),
        failed: stats.failed + (r === 'failed' ? 1 : 0),
        skipped: stats.skipped + (r === 'skipped' ? 1 : 0),
      };
    }

    return stats;
  }

  /**
   * Start a polling loop. The loop drains via `runOnce` then waits
   * `intervalMs` before the next drain.
   *
   * Exposed for production. Tests should prefer `runOnce` for
   * determinism.
   */
  start(intervalMs = 1000): void {
    if (this.running) return;
    this.running = true;
    const tick = async (): Promise<void> => {
      if (!this.running) return;
      try {
        await this.runOnce();
      } catch {
        // Defensive: never break the polling loop.
      }
      if (!this.running) return;
      this.timer = setTimeout(tick, intervalMs);
    };
    void tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async runClaimed(
    job: ClaimedJob,
  ): Promise<'succeeded' | 'retried' | 'failed' | 'skipped'> {
    const runner = this.deps.runners[job.jobType];
    const object = await this.deps.findObject({
      objectId: job.objectId,
      workspaceId: job.workspaceId,
    });

    // Parent object is deleted (or missing). Cancel the job — no point
    // doing the work.
    if (
      !object ||
      object.status === 'deleted' ||
      object.id !== job.objectId ||
      object.workspaceId !== job.workspaceId
    ) {
      await this.deps.queue.markFailed({
        jobId: job.id,
        errorCode: 'OBJECT_NOT_AVAILABLE',
        terminal: true,
        now: this.now(),
      });
      // Do NOT touch the aggregate status — the object is either gone
      // or already `deleted`.
      return 'failed';
    }

    if (!runner) {
      return this.handleFailure(job, object.workspaceId, object.id, 'RUNNER_MISSING', true);
    }

    if (!isFinalizedSource(object)) {
      await this.deps.queue.markFailed({
        jobId: job.id,
        errorCode: 'SCAN_SOURCE_UNBOUND',
        terminal: true,
        now: this.now(),
      });
      await this.deps.status.updateAggregateStatus({
        objectId: object.id,
        workspaceId: object.workspaceId,
        nextStatus: 'failed',
        now: this.now(),
      });
      return 'failed';
    }

    // XYN-SEC-001: no native metadata or pixel parsing until a required scan
    // for this object has succeeded. Check persisted state on every claim.
    if (job.jobType !== 'scan_validation') {
      let scanState: ScanValidationState;
      try {
        const jobs = await this.deps.queue.listForObject({
          objectId: object.id,
          workspaceId: object.workspaceId,
        });
        scanState = getScanValidationState(object, jobs);
      } catch {
        return this.handleFailure(
          job,
          object.workspaceId,
          object.id,
          'SCAN_STATE_UNAVAILABLE',
          true,
        );
      }
      if (scanState === 'pending') {
        await this.deps.queue.releaseClaimedJob({
          jobId: job.id,
          nextScheduledAt: new Date(this.now().getTime() + 1_000),
          now: this.now(),
        });
        return 'skipped';
      }
      if (scanState === 'blocked') {
        await this.deps.queue.markFailed({
          jobId: job.id,
          errorCode: 'SCAN_NOT_PASSED',
          terminal: true,
          now: this.now(),
        });
        // Missing/cancelled scan evidence is also a safety failure. Do not
        // let the normal best-effort variant aggregator mark it ready.
        await this.deps.status.updateAggregateStatus({
          objectId: object.id,
          workspaceId: object.workspaceId,
          nextStatus: 'failed',
          now: this.now(),
        });
        return 'failed';
      }
    }

    let result;
    try {
      result = (await runner({ job, object })) ?? {};
    } catch {
      return this.handleFailure(job, object.workspaceId, object.id, 'RUNNER_THREW', true);
    }

    if (result.errorCode) {
      const retryable = result.retryable !== false;
      return this.handleFailure(
        job,
        object.workspaceId,
        object.id,
        String(result.errorCode),
        retryable,
      );
    }

    await this.deps.queue.markSucceeded({
      jobId: job.id,
      now: this.now(),
      scanSource:
        job.jobType === 'scan_validation'
          ? { key: object.providerObjectKey, providerId: object.providerId }
          : undefined,
    });
    await this.updateParentAggregate(object.workspaceId, object.id);
    return 'succeeded';
  }

  private async handleFailure(
    job: ClaimedJob,
    workspaceId: string,
    objectId: string,
    errorCode: string,
    retryable: boolean,
  ): Promise<'retried' | 'failed'> {
    // `job.attempts` is the count of attempts BEFORE this one. The
    // current attempt is the (job.attempts + 1)-th. We retry if there is
    // room for at least one more attempt after this one fails — i.e. the
    // current attempt count (`job.attempts + 1`) is strictly less than
    // `maxAttempts`. At equality, this is the last attempt and a failure
    // is terminal.
    const currentAttemptNumber = job.attempts + 1;
    const canRetry = retryable && currentAttemptNumber < this.maxAttempts;
    if (canRetry) {
      const nextScheduledAt = new Date(this.now().getTime() + this.backoffSeconds * 1000);
      await this.deps.queue.markFailed({
        jobId: job.id,
        errorCode,
        terminal: false,
        now: this.now(),
        nextScheduledAt,
      });
      return 'retried';
    }
    await this.deps.queue.markFailed({
      jobId: job.id,
      errorCode,
      terminal: true,
      now: this.now(),
    });
    await this.updateParentAggregate(workspaceId, objectId);
    return 'failed';
  }

  private async updateParentAggregate(workspaceId: string, objectId: string): Promise<void> {
    const jobs = await this.deps.queue.listForObject({ objectId, workspaceId });
    const next = computeAggregateStatus(
      jobs.map((j: StorageProcessingJobRecord) => ({ status: j.status, required: j.required })),
    );
    if (!next) return;
    await this.deps.status.updateAggregateStatus({
      objectId,
      workspaceId,
      nextStatus: next,
      now: this.now(),
    });
  }
}

/** Tiny scan/validation runner stub for local dev / smoke tests. */
export const noopScanValidationRunner: JobRunner = async () => {
  return {};
};
