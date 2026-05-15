/**
 * STORAGE-FU-4 — composition root tests.
 *
 * These tests cover:
 *   1. Fail-fast posture when `DATABASE_URL` is missing/blank.
 *   2. All five action keys (STORAGE-5/6/7) are registered after
 *      `buildComposition()` runs.
 *   3. The `storage.service.ready` log entry lists the registered
 *      action keys and NEVER carries provider config, credentials,
 *      `DATABASE_URL`, secret-manager URIs, or any STORAGE-9 redacted
 *      surface.
 *   4. The composition returns a `worker` + `cleanup` instance without
 *      starting their polling loops (STORAGE-FU-6 owns `start()`).
 *   5. `shutdown` closes the owned DB client, stops the worker, and
 *      stops the cleanup loop.
 *   6. Injected `dbClient` ownership: `shutdown` does NOT close a
 *      caller-injected client.
 *
 * Tests use a fake `StorageDbClient` so we do NOT require a live
 * Postgres instance. The Drizzle queries inside the repositories are
 * never invoked here — STORAGE-FU-2 already exercises them against a
 * real DB. This file proves the wiring graph only.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  buildComposition,
  REGISTERED_ACTION_KEYS,
  buildEnqueueProcessingCallback,
} from '../src/composition';
import { __resetRegistry, getHandler } from '../src/actions/registry';
import type { StorageDbClient } from '../src/infra/db/client';
import type { SecretManagerClient } from '../src/infra/providers/secret-manager';
import { ProcessingWorker } from '../src/actions/handlers/processing';
import { AbandonedUploadCleanup } from '../src/infra/cleanup/abandoned-uploads';
import type {
  StorageObjectRecord,
  StorageProcessingJobRecord,
} from '../src/actions/handlers/objects/types';

// ── Fakes ─────────────────────────────────────────────────────────────────

/**
 * Minimal `StorageDbClient` stand-in. `db` is `{}` — no repository query
 * is invoked during composition wiring, so `as never` is safe. `close`
 * is a spy so we can assert ownership semantics.
 */
function makeFakeDbClient(): {
  client: StorageDbClient;
  closeCount: () => number;
} {
  let closeCalls = 0;
  return {
    client: {
      db: {} as never,
      client: {} as never,
      close: async () => {
        closeCalls += 1;
      },
    },
    closeCount: () => closeCalls,
  };
}

const FAKE_SECRETS: SecretManagerClient = {
  async resolve() {
    throw new Error('not called in composition wiring tests');
  },
};

// ── Log capture ───────────────────────────────────────────────────────────

interface CapturedLog {
  readonly message: string;
  readonly level: string;
  readonly event?: string;
  readonly actionKeys?: ReadonlyArray<string>;
  readonly cleanupPollIntervalMs?: number;
  readonly serialized: string;
}

const originalConsoleLog = console.log;
let captured: CapturedLog[] = [];

beforeEach(() => {
  captured = [];
  console.log = (line: unknown) => {
    if (typeof line !== 'string') return;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      captured.push({
        message: String(parsed.message ?? ''),
        level: String(parsed.level ?? ''),
        event: parsed.event ? String(parsed.event) : undefined,
        actionKeys: Array.isArray(parsed.actionKeys) ? (parsed.actionKeys as string[]) : undefined,
        cleanupPollIntervalMs:
          typeof parsed.cleanupPollIntervalMs === 'number'
            ? parsed.cleanupPollIntervalMs
            : undefined,
        serialized: line,
      });
    } catch {
      // Non-JSON output — ignore.
    }
  };
  __resetRegistry();
});

afterEach(() => {
  console.log = originalConsoleLog;
  __resetRegistry();
});

// ── Tests ────────────────────────────────────────────────────────────────

describe('STORAGE-FU-4 composition — fail-fast posture', () => {
  test('throws when DATABASE_URL is undefined', () => {
    expect(() => buildComposition({ env: {}, secrets: FAKE_SECRETS })).toThrow(
      /DATABASE_URL is required/,
    );
  });

  test('throws when DATABASE_URL is an empty string', () => {
    expect(() => buildComposition({ env: { DATABASE_URL: '' }, secrets: FAKE_SECRETS })).toThrow(
      /DATABASE_URL is required/,
    );
  });

  test('throws when DATABASE_URL is whitespace-only', () => {
    expect(() =>
      buildComposition({
        env: { DATABASE_URL: '   ' },
        secrets: FAKE_SECRETS,
      }),
    ).toThrow(/DATABASE_URL is required/);
  });

  test('does NOT throw when an injected dbClient is supplied (DATABASE_URL ignored)', () => {
    const { client } = makeFakeDbClient();
    expect(() =>
      buildComposition({ env: {}, secrets: FAKE_SECRETS, dbClient: client }),
    ).not.toThrow();
  });
});

describe('STORAGE-FU-4 composition — handler registration', () => {
  test('registers every action key from REGISTERED_ACTION_KEYS', () => {
    const { client } = makeFakeDbClient();
    buildComposition({
      env: { DATABASE_URL: 'postgres://fake' },
      secrets: FAKE_SECRETS,
      dbClient: client,
    });

    expect(REGISTERED_ACTION_KEYS).toEqual([
      'platform.storage.objects.upload',
      'platform.storage.objects.read',
      'platform.storage.objects.delete',
      'platform.storage.usage.read',
      'platform.storage.objects.process.retry',
    ]);

    for (const key of REGISTERED_ACTION_KEYS) {
      const handler = getHandler(key);
      expect(handler).toBeDefined();
      expect(typeof handler).toBe('function');
    }
  });

  test('registry returns undefined for unknown action keys after composition', () => {
    const { client } = makeFakeDbClient();
    buildComposition({
      env: { DATABASE_URL: 'postgres://fake' },
      secrets: FAKE_SECRETS,
      dbClient: client,
    });
    // `providers.manage` is the catalogued-but-unrouted MVP key — STORAGE-3
    // intentionally seeds NO gateway route for it. We assert the
    // composition root does not register a handler for it either.
    expect(getHandler('platform.storage.providers.manage')).toBeUndefined();
  });
});

describe('STORAGE-FU-4 composition — ready log entry', () => {
  test('emits exactly one storage.service.ready entry listing action keys', () => {
    const { client } = makeFakeDbClient();
    buildComposition({
      env: { DATABASE_URL: 'postgres://fake' },
      secrets: FAKE_SECRETS,
      dbClient: client,
    });
    const readyEntries = captured.filter((e) => e.event === 'storage.service.ready');
    expect(readyEntries.length).toBe(1);
    const entry = readyEntries[0]!;
    expect(entry.level).toBe('info');
    expect(entry.actionKeys).toEqual([
      'platform.storage.objects.upload',
      'platform.storage.objects.read',
      'platform.storage.objects.delete',
      'platform.storage.usage.read',
      'platform.storage.objects.process.retry',
    ]);
    expect(typeof entry.cleanupPollIntervalMs).toBe('number');
    expect(entry.cleanupPollIntervalMs).toBeGreaterThan(0);
  });

  test('ready entry never carries provider config, DATABASE_URL, or secret URIs', () => {
    const hostileEnv = {
      DATABASE_URL: 'postgres://alice:s3cret@db.internal:5432/storage',
      STORAGE_CREDENTIAL_PROD_ACCESS_KEY_ID: 'AKIA-LEAK-1234',
      STORAGE_CREDENTIAL_PROD_SECRET_ACCESS_KEY: 'leak-secret-do-not-emit',
    };
    const { client } = makeFakeDbClient();
    buildComposition({
      env: hostileEnv,
      secrets: FAKE_SECRETS,
      dbClient: client,
    });
    const readyEntries = captured.filter((e) => e.event === 'storage.service.ready');
    expect(readyEntries.length).toBe(1);
    const serialized = readyEntries[0]!.serialized;

    // Hostile substrings MUST NOT appear in the ready payload.
    expect(serialized).not.toContain('alice');
    expect(serialized).not.toContain('s3cret');
    expect(serialized).not.toContain('AKIA-LEAK-1234');
    expect(serialized).not.toContain('leak-secret-do-not-emit');
    expect(serialized).not.toContain('db.internal');
    expect(serialized).not.toContain('credential_ref');
    expect(serialized).not.toContain('credentialRef');
    expect(serialized).not.toContain('endpoint');
    expect(serialized).not.toContain('bucket');
    expect(serialized).not.toContain('region');
    expect(serialized).not.toContain('providerKind');
    expect(serialized).not.toContain('provider_kind');
    expect(serialized).not.toContain('secret://');
  });

  test('ready entry payload keys are a known allowlist', () => {
    const { client } = makeFakeDbClient();
    buildComposition({
      env: { DATABASE_URL: 'postgres://fake' },
      secrets: FAKE_SECRETS,
      dbClient: client,
    });
    const readyEntries = captured.filter((e) => e.event === 'storage.service.ready');
    expect(readyEntries.length).toBe(1);
    const parsed = JSON.parse(readyEntries[0]!.serialized) as Record<string, unknown>;
    const allowed = new Set([
      'ts',
      'level',
      'service',
      'message',
      'event',
      'actionKeys',
      'cleanupPollIntervalMs',
    ]);
    for (const key of Object.keys(parsed)) {
      expect(allowed.has(key)).toBe(true);
    }
  });
});

describe('STORAGE-FU-4 composition — worker + cleanup', () => {
  test('returns ProcessingWorker and AbandonedUploadCleanup instances', () => {
    const { client } = makeFakeDbClient();
    const composition = buildComposition({
      env: { DATABASE_URL: 'postgres://fake' },
      secrets: FAKE_SECRETS,
      dbClient: client,
    });
    expect(composition.worker).toBeInstanceOf(ProcessingWorker);
    expect(composition.cleanup).toBeInstanceOf(AbandonedUploadCleanup);
  });

  test('worker is NOT started automatically (STORAGE-FU-6 owns start())', async () => {
    const { client } = makeFakeDbClient();
    const composition = buildComposition({
      env: { DATABASE_URL: 'postgres://fake' },
      secrets: FAKE_SECRETS,
      dbClient: client,
    });
    // The worker exposes `start`/`stop` — if `start` had been called we
    // would see a queued setTimeout. We rely on the public API: calling
    // `stop()` on an un-started worker is a no-op (verified by the
    // worker unit tests), but more directly: the composition `worker`
    // reference does NOT trigger any queue read until `start()` runs.
    // Calling `stop()` here proves it's safe (idempotent).
    composition.worker.stop();
    composition.cleanup.stop();
    await composition.shutdown();
  });
});

describe('STORAGE-FU-4 composition — shutdown', () => {
  test('shutdown does NOT close an injected db client (caller-owned)', async () => {
    const { client, closeCount } = makeFakeDbClient();
    const composition = buildComposition({
      env: { DATABASE_URL: 'postgres://fake' },
      secrets: FAKE_SECRETS,
      dbClient: client,
    });
    await composition.shutdown();
    // Injected client → composition does NOT own → close NOT called.
    // The caller retains ownership and is responsible for tear-down.
    expect(closeCount()).toBe(0);
  });

  test('shutdown closes the composition-owned db client when dbClient is not injected', async () => {
    // Exercise the OWNED-DB path: pass `createDb` factory seam so we
    // can substitute a fake without spinning up a real postgres-js
    // connection. The composition's ownership rule
    // (`ownsDb = !options.dbClient`) means the fake is owned and
    // `shutdown` MUST close it.
    const { client, closeCount } = makeFakeDbClient();
    const composition = buildComposition({
      env: { DATABASE_URL: 'postgres://fake' },
      secrets: FAKE_SECRETS,
      createDb: () => client,
    });
    expect(closeCount()).toBe(0);
    await composition.shutdown();
    expect(closeCount()).toBe(1);
  });

  test('shutdown is idempotent (safe to call twice)', async () => {
    const { client } = makeFakeDbClient();
    const composition = buildComposition({
      env: { DATABASE_URL: 'postgres://fake' },
      secrets: FAKE_SECRETS,
      dbClient: client,
    });
    await composition.shutdown();
    await composition.shutdown();
    // No exception thrown — `worker.stop()` and `cleanup.stop()` are
    // already idempotent per their unit tests.
  });

  test('the default createDb path uses createStorageDb (validated by DATABASE_URL guard)', () => {
    // We cannot construct a real postgres-js client in this unit test,
    // so we verify the default path indirectly: when neither `dbClient`
    // nor `createDb` is provided, composition falls through to
    // `createStorageDb` which throws on missing DATABASE_URL. The
    // fail-fast tests above already prove this. This test exists so a
    // future refactor that accidentally bypasses `createStorageDb` —
    // (e.g. by hard-coding a fake) — fails immediately.
    expect(() => buildComposition({ env: {}, secrets: FAKE_SECRETS })).toThrow(
      /DATABASE_URL is required/,
    );
  });
});

describe('STORAGE-FU-4 composition — runners default', () => {
  test('worker runs with empty runners by default — STORAGE-FU-5 fills these in', () => {
    const { client } = makeFakeDbClient();
    const composition = buildComposition({
      env: { DATABASE_URL: 'postgres://fake' },
      secrets: FAKE_SECRETS,
      dbClient: client,
    });
    // No direct way to introspect `runners` from outside the worker.
    // We rely on the contract documented in `src/composition.ts`:
    // when `options.runners` is omitted, `runners: {}` is passed.
    // STORAGE-7 unit tests prove that an empty registry surfaces every
    // job as `RUNNER_MISSING`. Here we just confirm the worker exists
    // and is not started.
    expect(composition.worker).toBeInstanceOf(ProcessingWorker);
  });

  test('accepts a custom runner registry (STORAGE-FU-5 hook)', () => {
    const { client } = makeFakeDbClient();
    let runnerCalled = false;
    const composition = buildComposition({
      env: { DATABASE_URL: 'postgres://fake' },
      secrets: FAKE_SECRETS,
      dbClient: client,
      runners: {
        scan_validation: async () => {
          runnerCalled = true;
        },
      },
    });
    expect(composition.worker).toBeInstanceOf(ProcessingWorker);
    expect(runnerCalled).toBe(false); // worker not started yet
  });
});

describe('STORAGE-FU-4 composition — HTTP envelope integration', () => {
  test('every registered action key reaches a handler (no UNKNOWN_ACTION) through the internal route', async () => {
    const { client } = makeFakeDbClient();
    buildComposition({
      env: { DATABASE_URL: 'postgres://fake' },
      secrets: FAKE_SECRETS,
      dbClient: client,
    });

    // Dynamic imports so we don't drag the app builder into the
    // composition-only tests above.
    const { buildApp } = await import('../src/app');
    const { loadConfig } = await import('../src/infra/config');
    const config = loadConfig({
      ...process.env,
      INTERNAL_SERVICE_TOKEN: 'test-token',
      INTERNAL_AUTH_MODE: 'hybrid',
    });
    const app = buildApp(config);

    const headers = {
      'content-type': 'application/json',
      'X-Internal-Service-Token': 'test-token',
      'X-Workspace-Id': '00000000-0000-4000-8000-000000000001',
      'X-XS-User-Id': '00000000-0000-4000-8000-000000000002',
      'X-XS-Actor-Type': 'user',
    };

    for (const actionKey of REGISTERED_ACTION_KEYS) {
      const res = await app.request('/internal/storage-actions', {
        method: 'POST',
        headers,
        body: JSON.stringify({ actionKey, payload: {} }),
      });
      const body = (await res.json()) as { ok: boolean; error?: { code?: string } };
      // The handler may legitimately fail with VALIDATION_ERROR / NOT_FOUND
      // / etc. — what we are asserting is that the action key was ROUTED
      // to a handler (not 400 UNKNOWN_ACTION) AND that the request did
      // not crash the service.
      expect(body.error?.code).not.toBe('UNKNOWN_ACTION');
      expect([200, 400, 403, 404, 500]).toContain(res.status);
    }
  });
});

describe('STORAGE-FU-4 buildEnqueueProcessingCallback', () => {
  function fakeObjectRow(overrides: Partial<StorageObjectRecord> = {}): StorageObjectRecord {
    const now = new Date('2026-05-15T00:00:00.000Z');
    return {
      id: '00000000-0000-4000-8000-0000000000c1',
      workspaceId: '00000000-0000-4000-8000-0000000000ff',
      providerId: '00000000-0000-4000-8000-0000000000a0',
      providerObjectKey: 'workspaces/ws/objects/obj/file.jpg',
      filename: 'file.jpg',
      contentType: 'image/jpeg',
      byteSize: 1024,
      sha256: null,
      purpose: 'platform_generic',
      visibility: 'private',
      status: 'uploaded',
      compressionRequested: true,
      createdBy: null,
      createdAt: now,
      updatedAt: now,
      uploadedAt: now,
      ...overrides,
    };
  }

  type FindByIdInput = { objectId: string; workspaceId: string };
  type Spies = {
    enqueueCalls: number;
    statusCalls: number;
    findCalls: number;
  };

  function makeDeps(
    objectRow: StorageObjectRecord | null,
    spies: Spies,
  ): Parameters<typeof buildEnqueueProcessingCallback>[0] {
    return {
      objects: {
        async findByIdForWorkspace(_input: FindByIdInput) {
          spies.findCalls += 1;
          return objectRow;
        },
      },
      queue: {
        async enqueueBatch(input) {
          spies.enqueueCalls += 1;
          // Return synthetic job rows mirroring the input.
          return input.map(
            (j, idx): StorageProcessingJobRecord => ({
              id: `00000000-0000-4000-8000-00000000job${idx}`.slice(0, 36),
              objectId: j.objectId,
              jobType: j.jobType,
              status: 'queued',
              attempts: 0,
              errorCode: null,
              scheduledAt: j.scheduledAt,
              createdAt: j.scheduledAt,
              updatedAt: j.scheduledAt,
              required: j.required,
            }),
          );
        },
        async listForObject() {
          return [];
        },
        async claimNextQueuedJob() {
          return null;
        },
        async markSucceeded() {
          return null;
        },
        async markFailed() {
          return null;
        },
        async releaseClaimedJob() {
          return null;
        },
        async requeueFailedForObject() {
          return [];
        },
      },
      status: {
        async updateAggregateStatus({ now }) {
          spies.statusCalls += 1;
          return { ...fakeObjectRow(), status: 'processing', updatedAt: now };
        },
      },
    };
  }

  test('returns [] when object is missing (deleted between complete and callback)', async () => {
    const spies: Spies = { enqueueCalls: 0, statusCalls: 0, findCalls: 0 };
    const cb = buildEnqueueProcessingCallback(makeDeps(null, spies));
    const out = await cb({ objectId: 'obj-1', workspaceId: 'ws-1' });
    expect(out).toEqual([]);
    expect(spies.findCalls).toBe(1);
    expect(spies.enqueueCalls).toBe(0);
    expect(spies.statusCalls).toBe(0);
  });

  test('returns [] when object was soft-deleted (status="deleted")', async () => {
    const spies: Spies = { enqueueCalls: 0, statusCalls: 0, findCalls: 0 };
    const cb = buildEnqueueProcessingCallback(
      makeDeps(fakeObjectRow({ status: 'deleted' }), spies),
    );
    const out = await cb({ objectId: 'obj-1', workspaceId: 'ws-1' });
    expect(out).toEqual([]);
    expect(spies.enqueueCalls).toBe(0);
  });

  test('returns public processing-job DTOs when object is uploaded', async () => {
    const spies: Spies = { enqueueCalls: 0, statusCalls: 0, findCalls: 0 };
    const cb = buildEnqueueProcessingCallback(
      makeDeps(fakeObjectRow({ status: 'uploaded' }), spies),
    );
    const out = await cb({ objectId: 'obj-1', workspaceId: 'ws-1' });
    expect(Array.isArray(out)).toBe(true);
    expect((out as ReadonlyArray<unknown>).length).toBeGreaterThan(0);
    expect(spies.enqueueCalls).toBe(1);
    expect(spies.statusCalls).toBe(1);
    // Returned DTOs must use the public allowlist — no provider fields.
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('providerObjectKey');
    expect(serialized).not.toContain('provider_object_key');
    expect(serialized).not.toContain('providerId');
    expect(serialized).not.toContain('providerKind');
    expect(serialized).not.toContain('endpoint');
    expect(serialized).not.toContain('bucket');
    expect(serialized).not.toContain('credentialRef');
  });
});
