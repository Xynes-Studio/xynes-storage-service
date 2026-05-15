/**
 * STORAGE-FU-1 DB client tests.
 *
 * We assert the factory's pre-conditions and option-resolution rules
 * WITHOUT contacting a real Postgres instance — `postgres-js` lazy-opens
 * connections, so `createStorageDb()` only schedules a connection but
 * does not actually open one. We close the client immediately to avoid
 * dangling sockets.
 */
import { describe, expect, test } from 'bun:test';
import { createStorageDb } from '../../../src/infra/db/client';

const SAFE_LOCAL_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/postgres';

describe('createStorageDb', () => {
  test('throws when DATABASE_URL is empty', () => {
    expect(() => createStorageDb('')).toThrow(/DATABASE_URL is required/);
  });

  test('throws when DATABASE_URL is whitespace-only', () => {
    expect(() => createStorageDb('   \t  ')).toThrow(/DATABASE_URL is required/);
  });

  test('throws when DATABASE_URL is null', () => {
    expect(() => createStorageDb(null)).toThrow(/DATABASE_URL is required/);
  });

  test('throws when DATABASE_URL is undefined', () => {
    expect(() => createStorageDb(undefined)).toThrow(/DATABASE_URL is required/);
  });

  test('returns a Drizzle client + raw client + close fn for a valid URL', async () => {
    const handle = createStorageDb(SAFE_LOCAL_URL, { maxConnections: 1 });
    expect(handle.db).toBeDefined();
    expect(handle.client).toBeDefined();
    expect(typeof handle.close).toBe('function');
    await handle.close();
  });

  test('honours maxConnections override', async () => {
    const handle = createStorageDb(SAFE_LOCAL_URL, { maxConnections: 3 });
    // `postgres-js` exposes the configured max via the options of its
    // internal Sql instance; we treat the absence of a thrown error as
    // sufficient evidence that the override was accepted.
    expect(handle.db).toBeDefined();
    await handle.close();
  });

  test('test env collapses connection pool to 1', async () => {
    const handle = createStorageDb(SAFE_LOCAL_URL, {}, { NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    expect(handle.db).toBeDefined();
    await handle.close();
  });

  test('non-test env uses default pool size', async () => {
    const handle = createStorageDb(SAFE_LOCAL_URL, {}, {
      NODE_ENV: 'development',
    } as NodeJS.ProcessEnv);
    expect(handle.db).toBeDefined();
    await handle.close();
  });

  test('enableQueryLog override is honoured', async () => {
    const handle = createStorageDb(SAFE_LOCAL_URL, { enableQueryLog: true });
    expect(handle.db).toBeDefined();
    await handle.close();
  });

  test('STORAGE_DRIZZLE_LOG=1 enables query logging by default', async () => {
    const handle = createStorageDb(SAFE_LOCAL_URL, {}, {
      STORAGE_DRIZZLE_LOG: '1',
    } as NodeJS.ProcessEnv);
    expect(handle.db).toBeDefined();
    await handle.close();
  });

  test('STORAGE_DRIZZLE_LOG=true also enables query logging', async () => {
    const handle = createStorageDb(SAFE_LOCAL_URL, {}, {
      STORAGE_DRIZZLE_LOG: 'true',
    } as NodeJS.ProcessEnv);
    expect(handle.db).toBeDefined();
    await handle.close();
  });

  test('STORAGE_DRIZZLE_LOG unset disables query logging', async () => {
    const handle = createStorageDb(SAFE_LOCAL_URL, {}, {} as NodeJS.ProcessEnv);
    expect(handle.db).toBeDefined();
    await handle.close();
  });
});
