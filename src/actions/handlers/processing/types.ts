/**
 * STORAGE-7 — async processing queue contract.
 *
 * Storage-7 adds:
 *   1. A **job planner** that, given a completed `StorageObjectRecord`,
 *      yields a deterministic list of processing jobs to enqueue
 *      (scan/validation, image optimisation, video probe/thumbnail/
 *      transcode, document preview).
 *   2. A **job queue repository** contract for the
 *      `platform.storage_processing_jobs` table. Production wires a
 *      Drizzle-backed implementation; tests inject in-memory fakes.
 *   3. A **job aggregator** that maps a list of jobs onto the parent
 *      object's aggregate `ObjectStatus`:
 *        - `processing` while ≥ 1 required job is queued/running
 *        - `failed`     when ≥ 1 required job is terminally failed
 *        - `ready`      when all required jobs succeeded
 *      Non-required jobs (e.g. best-effort thumbnails) never block
 *      `ready`.
 *   4. A **worker engine** that polls the queue, claims jobs atomically
 *      (concurrency-safe), runs them via a per-jobType `JobRunner`
 *      registry, applies retry / dead-letter logic, and updates the
 *      parent object's aggregate status after each terminal transition.
 *   5. A **retry action handler** for action key
 *      `platform.storage.objects.process.retry` that requeues failed
 *      jobs for an object.
 *
 * Repositories surface DTOs (NOT raw rows). The handlers / worker
 * NEVER echo `provider_object_key`, `provider_id`, `credential_ref`, or
 * raw provider error envelopes back to callers — defense-in-depth on top
 * of the response builders in `responses.ts`.
 *
 * Concurrency contract: `claimNextQueuedJob` MUST be atomic. The Drizzle
 * implementation MUST use a `SELECT … FOR UPDATE SKIP LOCKED` (Postgres)
 * or equivalent so two workers cannot claim the same job. The in-memory
 * fake mimics this by guarding with a small in-process lock.
 */
import type {
  ObjectStatus,
  StorageObjectRecord,
  StorageProcessingJobRecord,
  ProcessingJobStatus,
} from '../objects/types';

// Re-export for convenience.
export type { ObjectStatus, StorageProcessingJobRecord, ProcessingJobStatus };

// ── Job types (closed enum; new jobs must be added intentionally) ──────────

/**
 * Closed set of job types the planner can emit. The worker `runners`
 * registry MUST contain a runner for every required job type the planner
 * can emit; a missing runner is treated as an `INTERNAL_ERROR` for that
 * job (which fails-closed onto the aggregate parent status).
 */
export const PROCESSING_JOB_TYPES = [
  'scan_validation',
  'image_optimize',
  'video_probe',
  'video_thumbnail',
  'video_transcode',
  'document_preview',
] as const;

export type ProcessingJobType = (typeof PROCESSING_JOB_TYPES)[number];

// ── Job plan (output of `planProcessingJobs`) ──────────────────────────────

/**
 * One planned-but-not-yet-enqueued job. The planner emits these
 * deterministically from `(contentType, compressionRequested)`.
 *
 * `required = true` means a terminal failure on this job flips the
 * parent object to `failed`. Required jobs are the safety-critical
 * ones (scan/validation, video probe). Best-effort variants
 * (thumbnails, transcodes, document previews) ship `required = false`
 * so a transient ffmpeg blip does not "ruin" an otherwise-good upload.
 */
export interface ProcessingJobPlan {
  readonly jobType: ProcessingJobType;
  readonly required: boolean;
  /**
   * Worker-runner-facing payload. NEVER contains provider config or
   * credentials — the runner resolves the provider via the resolver
   * at run time, NOT from the job payload.
   */
  readonly payload: Readonly<Record<string, unknown>>;
}

// ── Queue repository ───────────────────────────────────────────────────────

export interface EnqueueJobInput {
  readonly id: string;
  readonly objectId: string;
  readonly workspaceId: string;
  readonly jobType: ProcessingJobType;
  readonly required: boolean;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly scheduledAt: Date;
}

export interface ClaimedJob {
  readonly id: string;
  readonly objectId: string;
  readonly workspaceId: string;
  readonly jobType: ProcessingJobType;
  readonly required: boolean;
  readonly payload: Readonly<Record<string, unknown>>;
  /**
   * Count of attempts ALREADY recorded for this job BEFORE the current
   * claim. `attempts === 0` means this is the very first attempt. The
   * worker bumps the counter via `markSucceeded` / `markFailed` —
   * `claimNextQueuedJob` MUST NOT increment it.
   */
  readonly attempts: number;
  /**
   * Hard cap on the total number of attempts the worker is allowed to
   * make (including the current one). Once `attempts + 1 >= maxAttempts`
   * AND the runner has failed, the worker marks the job terminally
   * failed and dead-letters it.
   */
  readonly maxAttempts: number;
}

export interface MarkJobFailedInput {
  readonly jobId: string;
  readonly errorCode: string;
  readonly now: Date;
  /**
   * When true the queue repo MUST update `status = 'failed'`
   * (terminal) and bump `attempts`. When false the queue repo MUST
   * update `status = 'queued'`, bump `attempts`, and stamp
   * `scheduledAt = nextScheduledAt`.
   */
  readonly terminal: boolean;
  /** Required when `terminal = false`. */
  readonly nextScheduledAt?: Date;
}

export interface ProcessingJobQueueRepository {
  /**
   * Insert a batch of `queued` jobs in one transaction. Implementations
   * MUST reject duplicate `(objectId, jobType)` pairs already in the
   * queue UNLESS the existing row is in a terminal state — the planner
   * is responsible for not double-enqueueing within a single transition;
   * the repo is the last line of defence.
   */
  enqueueBatch(
    input: ReadonlyArray<EnqueueJobInput>,
  ): Promise<ReadonlyArray<StorageProcessingJobRecord>>;

  /**
   * List jobs for an object in any state. Used by the aggregator + by
   * STORAGE-6's GET handler.
   */
  listForObject(input: {
    objectId: string;
    workspaceId: string;
  }): Promise<ReadonlyArray<StorageProcessingJobRecord>>;

  /**
   * Atomically claim the next due `queued` job and flip it to `running`.
   * MUST be safe under concurrent workers (Postgres:
   * `SELECT … FOR UPDATE SKIP LOCKED`).
   *
   * Implementations MUST NOT bump `attempts` here — the worker is the
   * sole authority for the attempts counter. A claim that is later
   * released via `releaseClaimedJob` (per-workspace-cap path) MUST NOT
   * be counted as an attempt.
   *
   * Returns `null` when no due jobs are available.
   */
  claimNextQueuedJob(input: {
    now: Date;
    /**
     * Optional workspace allowlist for per-workspace concurrency caps:
     * when set, the worker has already booked a slot for these
     * workspaces and the claim MUST be restricted to them so a busy
     * workspace cannot starve siblings.
     */
    workspaceAllowlist?: ReadonlyArray<string>;
  }): Promise<ClaimedJob | null>;

  /** Mark a running job `succeeded`. MUST bump `attempts`. */
  markSucceeded(input: { jobId: string; now: Date }): Promise<StorageProcessingJobRecord | null>;

  /**
   * Mark a running job either `failed` (terminal) or back to `queued`
   * with a backoff (retry). The decision lives at the worker layer.
   * Implementations MUST bump `attempts` in both branches — both
   * branches represent a completed attempt by the runner.
   */
  markFailed(input: MarkJobFailedInput): Promise<StorageProcessingJobRecord | null>;

  /**
   * Release a previously-claimed job WITHOUT counting it as an attempt.
   * Used by the worker's per-workspace-cap flow-control path. Flips
   * status back to `queued`, stamps `scheduledAt = nextScheduledAt`,
   * and leaves `attempts` untouched. Returns the updated row or `null`
   * when the job is not in `running` state.
   */
  releaseClaimedJob(input: {
    jobId: string;
    nextScheduledAt: Date;
    now: Date;
  }): Promise<StorageProcessingJobRecord | null>;

  /**
   * Requeue terminally-failed jobs for an object — used by the retry
   * action handler. Sets `status = 'queued'`, `attempts = 0`,
   * `errorCode = NULL`, `scheduledAt = now`. Returns the updated rows.
   *
   * Implementations MUST NOT touch jobs that are NOT terminal — a
   * `running` job is owned by a worker and must not be yanked out
   * from under it.
   */
  requeueFailedForObject(input: {
    objectId: string;
    workspaceId: string;
    now: Date;
  }): Promise<ReadonlyArray<StorageProcessingJobRecord>>;
}

// ── Object aggregate-status repository ────────────────────────────────────

export interface StorageObjectStatusRepository {
  /**
   * Conditional status update. Implementations MUST NOT clobber
   * `deleted` rows. Returns the updated row, or `null` when the row
   * does not exist / is `deleted` / belongs to a different workspace.
   */
  updateAggregateStatus(input: {
    objectId: string;
    workspaceId: string;
    nextStatus: Extract<ObjectStatus, 'processing' | 'ready' | 'failed'>;
    now: Date;
  }): Promise<StorageObjectRecord | null>;
}

// ── Job runner contract ───────────────────────────────────────────────────

/**
 * Runs ONE job. Implementations live in STORAGE-8 (image / video /
 * document profiles). STORAGE-7 ships a tiny no-op `scan_validation`
 * stub for the local dev story and a `RunnerNotImplementedError` thrown
 * by any job type without a registered runner — non-required jobs
 * gracefully retry-then-dead-letter; required jobs flip the parent to
 * `failed`.
 */
export type JobRunnerContext = {
  readonly job: ClaimedJob;
  readonly object: StorageObjectRecord;
};

export interface JobRunResult {
  /** Optional code emitted on failure. NEVER includes raw provider error text. */
  readonly errorCode?: string;
  /** When false, the worker treats the failure as retryable. */
  readonly retryable?: boolean;
}

export type JobRunner = (ctx: JobRunnerContext) => Promise<JobRunResult | void>;

// ── Worker dependency injection ───────────────────────────────────────────

export interface ProcessingWorkerDependencies {
  readonly queue: ProcessingJobQueueRepository;
  readonly status: StorageObjectStatusRepository;
  /** Lookup the object row attached to a claimed job. */
  readonly findObject: (input: {
    objectId: string;
    workspaceId: string;
  }) => Promise<StorageObjectRecord | null>;
  readonly runners: Readonly<Partial<Record<ProcessingJobType, JobRunner>>>;
  readonly now?: () => Date;
  /** Maximum concurrent jobs running across the whole worker. Default 4. */
  readonly maxConcurrent?: number;
  /** Maximum concurrent jobs per workspace. Default 2. */
  readonly maxConcurrentPerWorkspace?: number;
  /** Maximum attempts per job (including the first). Default 3. */
  readonly maxAttempts?: number;
  /** Backoff in seconds for retried jobs. Default 60. */
  readonly retryBackoffSeconds?: number;
}

// ── Enqueue handler dependency type ───────────────────────────────────────

export interface EnqueueDependencies {
  readonly queue: ProcessingJobQueueRepository;
  readonly status: StorageObjectStatusRepository;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

// ── Retry handler dependency type ─────────────────────────────────────────

export interface RetryHandlerDependencies {
  readonly queue: ProcessingJobQueueRepository;
  readonly status: StorageObjectStatusRepository;
  readonly objects: {
    findByIdForWorkspace(input: {
      objectId: string;
      workspaceId: string;
    }): Promise<StorageObjectRecord | null>;
  };
  readonly now?: () => Date;
}
