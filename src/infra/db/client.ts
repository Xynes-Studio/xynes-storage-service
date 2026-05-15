/**
 * Postgres client + Drizzle wrapper for `xynes-storage-service`.
 *
 * Composition root contract (STORAGE-FU-4):
 *   - Production callers MUST construct ONE `StorageDbClient` per process
 *     via `createStorageDb(databaseUrl, options?)` and inject it into every
 *     repository (STORAGE-FU-2). No module-level singleton is exported on
 *     purpose — STORAGE-FU-4 will wire the singleton in `src/composition.ts`
 *     so test code can inject ephemeral instances without monkey-patching.
 *   - The factory throws when `databaseUrl` is missing/blank. The
 *     composition root must catch this and fail fast on startup, matching
 *     the gateway's `DATABASE_URL`-required posture.
 *   - `STORAGE_DRIZZLE_LOG=1` enables Drizzle's query logger. Off by
 *     default. The logger is a no-op-friendly hook; STORAGE-9 redaction
 *     rules are applied at log-emit time inside `infra/logger.ts`, NOT
 *     here, so this client never has to know about provider credentials.
 *
 * Connection-pool sizing rationale:
 *   - `NODE_ENV=test` collapses to one connection so integration tests
 *     never deadlock against in-flight migrations.
 *   - Default `max: 10` matches `xynes-accounts-service` so the two
 *     services do not collectively exhaust the local Postgres connection
 *     budget under dev concurrency.
 */
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import * as schema from './schema';

export type StorageDb = PostgresJsDatabase<typeof schema>;

export interface StorageDbClient {
  readonly db: StorageDb;
  readonly client: Sql;
  readonly close: () => Promise<void>;
}

export interface CreateStorageDbOptions {
  /** Override pool size; defaults derive from NODE_ENV. */
  readonly maxConnections?: number;
  /** Override Drizzle query logging; defaults to the `STORAGE_DRIZZLE_LOG` env. */
  readonly enableQueryLog?: boolean;
}

function defaultMaxConnections(env: NodeJS.ProcessEnv): number {
  return env.NODE_ENV === 'test' ? 1 : 10;
}

function defaultQueryLog(env: NodeJS.ProcessEnv): boolean {
  return env.STORAGE_DRIZZLE_LOG === '1' || env.STORAGE_DRIZZLE_LOG === 'true';
}

/**
 * Construct a storage-service-scoped Drizzle client.
 *
 * @throws Error when `databaseUrl` is missing or blank. The composition
 * root MUST treat this as a startup failure.
 */
export function createStorageDb(
  databaseUrl: string | undefined | null,
  options: CreateStorageDbOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): StorageDbClient {
  if (!databaseUrl || databaseUrl.trim() === '') {
    throw new Error(
      'DATABASE_URL is required to construct the storage-service Drizzle client. ' +
        'Set DATABASE_URL in your environment before calling createStorageDb.',
    );
  }

  const max = options.maxConnections ?? defaultMaxConnections(env);
  const logger = options.enableQueryLog ?? defaultQueryLog(env);

  const client = postgres(databaseUrl, {
    max,
    prepare: false,
    connect_timeout: 2,
    idle_timeout: 2,
    onnotice: () => {
      /* suppress Postgres NOTICE chatter in service logs */
    },
  });

  const db = drizzle(client, { schema, logger });

  return {
    db,
    client,
    close: () => client.end({ timeout: 5 }),
  };
}
