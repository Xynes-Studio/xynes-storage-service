/**
 * STORAGE-FU-4 — composition root for `xynes-storage-service`.
 *
 * Responsibilities (per
 * `xynes-infra/docs/plans/archive/2026-05-14-storage-register-handlers-and-drizzle-wiring.md`
 * §7):
 *
 *   1. Construct ONE `StorageDbClient` (STORAGE-FU-1) from `DATABASE_URL`.
 *   2. Construct every Drizzle-backed repository (STORAGE-FU-2).
 *   3. Construct the `PostgresExtendedStorageProviderResolver` plus the
 *      configured `SecretManagerClient` (STORAGE-FU-3). Today only the
 *      local-dev `EnvSecretManagerClient` is supported — hosted backends
 *      (AWS Secrets Manager, GCP Secret Manager, Doppler, Vault) land as
 *      per-environment follow-up stories per plan §6 "Out of scope".
 *   4. Register every action handler shipped by STORAGE-5/6/7 on the
 *      shared action registry so the internal route stops returning
 *      `400 UNKNOWN_ACTION` for production traffic.
 *   5. Emit ONE structured `storage.service.ready` log entry listing the
 *      registered action keys. The entry MUST NOT carry provider config,
 *      credentials, secret-manager URIs, or any other STORAGE-9 redacted
 *      surface (the logger redactor is a second line of defence; this
 *      entry deliberately stays narrow).
 *   6. Construct (but do NOT `start()`) the `ProcessingWorker` and
 *      `AbandonedUploadCleanup` instances. The polling-loop `start()`
 *      calls land with STORAGE-FU-6 alongside the graceful-shutdown
 *      wiring.
 *
 * Non-responsibilities (deliberately deferred):
 *   - STORAGE-FU-5 PRODUCTION ADAPTERS: the composition wires the
 *     STORAGE-FU-5 runner registry (provider IO + variant writer +
 *     stub-mode processors by default). The PRODUCTION sharp / ffmpeg
 *     / libreoffice / clamav adapters are deliberate follow-up infra
 *     stories — until they land, `STORAGE_PROCESSOR_MODE=live`
 *     selects the safe-fail `Production*ProcessorStub`s which throw
 *     `UNSUPPORTED_FORMAT` per the STORAGE-7 closed-set runner error
 *     code, so misconfigured production sees deterministic failures.
 *     Tests can still pass `options.runners` to override the registry.
 *   - STORAGE-FU-6: worker `start()` invocations + graceful shutdown.
 *
 * Composition root MUST fail fast on startup if `DATABASE_URL` is unset
 * — matches the gateway's `DATABASE_URL`-required posture (STORAGE-FU-1
 * `createStorageDb` already throws; we let that propagate).
 */
import {
  registerUploadActionHandlers,
  STORAGE_UPLOAD_ACTION_KEY,
} from './actions/handlers/uploads';
import {
  registerObjectActionHandlers,
  STORAGE_OBJECTS_DELETE_ACTION_KEY,
  STORAGE_OBJECTS_READ_ACTION_KEY,
  STORAGE_USAGE_READ_ACTION_KEY,
} from './actions/handlers/objects';
import {
  registerProcessingActionHandlers,
  STORAGE_PROCESS_RETRY_ACTION_KEY,
  ProcessingWorker,
  enqueueProcessingForObject,
} from './actions/handlers/processing';
import { createStorageDb, type StorageDbClient } from './infra/db/client';
import {
  PostgresAbandonedUploadSessionRepository,
  PostgresExtendedStorageObjectRepository,
  PostgresExtendedStorageProviderResolver,
  PostgresProcessingJobQueueRepository,
  PostgresStorageObjectRepository,
  PostgresStorageObjectStatusRepository,
  PostgresStorageProcessingJobRepository,
  PostgresStorageUsageRepository,
  PostgresStorageVariantRepository,
  PostgresUploadSessionRepository,
} from './infra/db/repositories';
import {
  AbandonedUploadCleanup,
  STORAGE_CLEANUP_DEFAULT_POLL_INTERVAL_MS,
} from './infra/cleanup/abandoned-uploads';
import { EnvSecretManagerClient, type SecretManagerClient } from './infra/providers/secret-manager';
import {
  createRunnerDependencies,
  createS3ProviderObjectIO,
  PostgresStorageVariantWriter,
  resolveProcessorMode,
  type ProcessorMode,
} from './infra/processors';
import { toPublicProcessingJob } from './actions/handlers/objects/responses';
import { logger } from './infra/logger';
import type { JobRunner, ProcessingJobType } from './actions/handlers/processing';
import type { ExtendedStorageObjectRepository } from './actions/handlers/objects/types';
import type {
  ProcessingJobQueueRepository,
  StorageObjectStatusRepository,
} from './actions/handlers/processing/types';

/**
 * The action keys this composition root registers handlers for. Exposed
 * for tests + the `storage.service.ready` log entry so operators can
 * verify the surface at startup without grep'ing source.
 */
export const REGISTERED_ACTION_KEYS = [
  STORAGE_UPLOAD_ACTION_KEY,
  STORAGE_OBJECTS_READ_ACTION_KEY,
  STORAGE_OBJECTS_DELETE_ACTION_KEY,
  STORAGE_USAGE_READ_ACTION_KEY,
  STORAGE_PROCESS_RETRY_ACTION_KEY,
] as const;

// Strict integer pre-check — same regex used by `parsePositiveIntMs`
// in `src/infra/lifecycle.ts`. Keeps the two parsers in sync so envs
// like `STORAGE_WORKER_MAX_CONCURRENT="1e3"` cannot silently become
// `1` (Codex P2 review on PR #14).
const STRICT_INT_PATTERN = /^-?\d+$/;

/**
 * Parse a positive-integer env value. Returns `undefined` when the
 * value is missing / blank / non-numeric / non-finite / <= 0 so the
 * caller can let the consumer's own default win (STORAGE-7 worker
 * defaults: 4 global / 2 per-workspace).
 *
 * Mirrors the `parsePositiveIntMs` helper from `infra/lifecycle.ts`
 * but returns `undefined` (not a fallback) so the spread-into-options
 * pattern at the worker constructor stays clean.
 *
 * Strict integer semantics (rejects floats, scientific notation,
 * trailing garbage, and unsafe integer overflow) — see
 * `parsePositiveIntMs` for the same contract.
 */
function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  if (!STRICT_INT_PATTERN.test(trimmed)) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

export interface CompositionRoot {
  readonly db: StorageDbClient;
  readonly worker: ProcessingWorker;
  readonly cleanup: AbandonedUploadCleanup;
  /** Async resource teardown — closes the Drizzle pool and stops the workers. */
  readonly shutdown: () => Promise<void>;
}

export interface BuildCompositionOptions {
  /**
   * Optional `SecretManagerClient` override. Production composition will
   * select the hosted implementation here (AWS Secrets Manager / GCP /
   * Doppler / Vault) once those follow-ups land. Defaults to the
   * env-backed local-dev implementation (`EnvSecretManagerClient`).
   */
  readonly secrets?: SecretManagerClient;
  /**
   * Optional runner registry override (STORAGE-FU-5 test seam). When
   * omitted, the composition wires `createRunnerDependencies` against
   * a `createS3ProviderObjectIO` + `PostgresStorageVariantWriter` +
   * mode-selected stub/production processors. When supplied (tests +
   * STORAGE-FU-4 baseline tests that exercise pre-STORAGE-FU-5
   * posture), the override is honoured byte-for-byte and STORAGE-FU-5
   * wiring is skipped.
   */
  readonly runners?: Readonly<Partial<Record<ProcessingJobType, JobRunner>>>;
  /**
   * Optional env reader. Defaults to `process.env`.
   */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Optional DB client override. Production paths omit this; tests can
   * inject an ephemeral postgres-js instance constructed elsewhere.
   *
   * When set, `shutdown` will NOT close the injected client — ownership
   * stays with the caller.
   */
  readonly dbClient?: StorageDbClient;
  /**
   * Optional DB client factory. When set AND `dbClient` is NOT injected,
   * `buildComposition` calls this to construct the client. Composition
   * owns the resulting client and `shutdown` closes it. Tests use this
   * seam to exercise the OWNED-DB-CLOSE path without a live Postgres.
   * Production omits this and gets `createStorageDb`.
   */
  readonly createDb?: (
    databaseUrl: string | undefined | null,
    env: NodeJS.ProcessEnv,
  ) => StorageDbClient;
}

/**
 * Build the composition root, register every action handler, and emit
 * the structured ready event. Returns the worker + cleanup instances
 * (STORAGE-FU-6 will call `start()` on them once graceful shutdown
 * lands).
 *
 * @throws Error when `DATABASE_URL` is missing or blank (from
 *   `createStorageDb`).
 */
export function buildComposition(options: BuildCompositionOptions = {}): CompositionRoot {
  const env = options.env ?? process.env;

  // STORAGE-FU-1 will throw with a clear message when the env var is
  // unset; we deliberately let it propagate so the service crashes loudly
  // at startup rather than silently registering handlers against a null
  // database.
  const ownsDb = !options.dbClient;
  const createDb = options.createDb ?? ((url, e) => createStorageDb(url, {}, e));
  const db = options.dbClient ?? createDb(env.DATABASE_URL, env);

  // STORAGE-FU-2 repositories. One instance per contract; shared `db`.
  const objectRepo = new PostgresStorageObjectRepository(db.db);
  const extendedObjectRepo = new PostgresExtendedStorageObjectRepository(db.db);
  const uploadSessionRepo = new PostgresUploadSessionRepository(db.db);
  const abandonedSessionRepo = new PostgresAbandonedUploadSessionRepository(db.db);
  const objectStatusRepo = new PostgresStorageObjectStatusRepository(db.db);
  const variantRepo = new PostgresStorageVariantRepository(db.db);
  const processingJobRepo = new PostgresStorageProcessingJobRepository(db.db);
  const queueRepo = new PostgresProcessingJobQueueRepository(db.db);
  const usageRepo = new PostgresStorageUsageRepository(db.db);

  // STORAGE-FU-3 provider resolver + secret manager.
  const secrets = options.secrets ?? new EnvSecretManagerClient({ env });
  const providerResolver = new PostgresExtendedStorageProviderResolver(db.db, secrets);

  // STORAGE-7 enqueue callback. Bound to the production queue + status
  // repositories so the upload-complete handler kicks off processing for
  // every newly-uploaded object. The callback returns the public
  // processing-job DTOs (allowlist-only) — handler responses build on
  // top of that without re-shaping rows.
  const enqueueProcessing = buildEnqueueProcessingCallback({
    objects: extendedObjectRepo,
    queue: queueRepo,
    status: objectStatusRepo,
  });

  // STORAGE-5: upload action handler.
  registerUploadActionHandlers({
    objects: objectRepo,
    sessions: uploadSessionRepo,
    providers: providerResolver,
    enqueueProcessing,
  });

  // STORAGE-6: object metadata / signed read / delete / usage handlers.
  registerObjectActionHandlers({
    objects: extendedObjectRepo,
    variants: variantRepo,
    jobs: processingJobRepo,
    usage: usageRepo,
    providers: providerResolver,
  });

  // STORAGE-7: process-retry handler.
  registerProcessingActionHandlers({
    queue: queueRepo,
    status: objectStatusRepo,
    objects: extendedObjectRepo,
  });

  // STORAGE-FU-5: build the production runner registry. The processor
  // mode (`stub` vs `live`) is resolved from `STORAGE_PROCESSOR_MODE`
  // env (default `stub` outside production, `live` inside). When the
  // caller supplies an explicit `runners` override (tests, STORAGE-FU-4
  // baseline posture) we honour it and skip the production wiring.
  let resolvedRunners = options.runners;
  let processorMode: ProcessorMode | 'override' = 'override';
  if (!resolvedRunners) {
    const providerIO = createS3ProviderObjectIO({ providers: providerResolver });
    const variantWriter = new PostgresStorageVariantWriter({ db: db.db });
    const runnerDeps = createRunnerDependencies({
      providerIO,
      variants: variantWriter,
      env,
    });
    resolvedRunners = runnerDeps.registry;
    processorMode = runnerDeps.mode;
  } else if (env.STORAGE_PROCESSOR_MODE !== undefined) {
    // Diagnostic: even when an override is supplied, surface the
    // resolved mode the env would have chosen — useful for the
    // ready-event log.
    processorMode = resolveProcessorMode(env);
  }

  // STORAGE-FU-6 will call `worker.start()` / `cleanup.start()`. We
  // construct them here so the composition graph is complete and the
  // ready-event log accurately reflects what the service is wired to do.
  //
  // Concurrency caps are env-configurable per STORAGE-FU-6 acceptance
  // criteria (`STORAGE_WORKER_MAX_CONCURRENT` / `STORAGE_WORKER_MAX_PER_WORKSPACE`).
  // Missing / blank / non-positive values fall through to the
  // `ProcessingWorker` defaults (4 global / 2 per-workspace) — matches
  // STORAGE-7 §"Out of scope" posture.
  const workerMaxConcurrent = parsePositiveInt(env.STORAGE_WORKER_MAX_CONCURRENT);
  const workerMaxPerWorkspace = parsePositiveInt(env.STORAGE_WORKER_MAX_PER_WORKSPACE);
  const worker = new ProcessingWorker({
    queue: queueRepo,
    status: objectStatusRepo,
    findObject: (input) => extendedObjectRepo.findByIdForWorkspace(input),
    runners: resolvedRunners,
    ...(workerMaxConcurrent !== undefined ? { maxConcurrent: workerMaxConcurrent } : {}),
    ...(workerMaxPerWorkspace !== undefined
      ? { maxConcurrentPerWorkspace: workerMaxPerWorkspace }
      : {}),
  });

  const cleanup = new AbandonedUploadCleanup({
    sessions: abandonedSessionRepo,
    objects: objectRepo,
    providers: providerResolver,
  });

  // STORAGE-9 invariant: the ready entry deliberately stays narrow — no
  // provider config, no `DATABASE_URL`, no `credentialRef`, no log of
  // env values. The action-key list + processor mode are the only payload.
  logger.info('storage.service.ready', {
    event: 'storage.service.ready',
    actionKeys: REGISTERED_ACTION_KEYS,
    cleanupPollIntervalMs: STORAGE_CLEANUP_DEFAULT_POLL_INTERVAL_MS,
    processorMode,
  });

  return {
    db,
    worker,
    cleanup,
    shutdown: async () => {
      worker.stop();
      cleanup.stop();
      if (ownsDb) {
        await db.close();
      }
    },
  };
}

/**
 * Build the STORAGE-7 enqueue-processing callback for the upload
 * complete handler.
 *
 * Extracted as a named export so unit tests can drive the
 * deleted-between-complete-and-callback fast-path without touching the
 * full composition graph.
 *
 * Behaviour:
 *   - Looks up the object after session-complete.
 *   - If the object is missing OR was soft-deleted in the window
 *     between session-complete and this callback, returns `[]`. The
 *     worker would have discovered the deletion and cancelled jobs
 *     anyway; we silently drop here so the upload-complete success
 *     stands.
 *   - Otherwise plans + enqueues the deterministic STORAGE-7 job set
 *     and returns the public DTOs (allowlist-only).
 */
export function buildEnqueueProcessingCallback(deps: {
  readonly objects: Pick<ExtendedStorageObjectRepository, 'findByIdForWorkspace'>;
  readonly queue: ProcessingJobQueueRepository;
  readonly status: StorageObjectStatusRepository;
}): (input: { objectId: string; workspaceId: string }) => Promise<ReadonlyArray<unknown>> {
  return async (input) => {
    const object = await deps.objects.findByIdForWorkspace(input);
    if (!object || object.status === 'deleted') {
      return [];
    }
    const result = await enqueueProcessingForObject(
      { queue: deps.queue, status: deps.status },
      object,
    );
    return result.jobs.map(toPublicProcessingJob);
  };
}
