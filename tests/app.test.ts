/**
 * App + middleware tests.
 *
 * Exercise health, ready, error handling, and the internal route's actor
 * parsing surface. Handlers themselves land in STORAGE-5 — for STORAGE-4
 * we register a tiny capturing test handler at runtime to confirm the
 * envelope + actor parsing path is wired correctly.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { buildApp } from '../src/app';
import { loadConfig, type ServiceConfig } from '../src/infra/config';
import { registerHandler, __resetRegistry } from '../src/actions/registry';
import type { ActionContext, StorageActionKey, StorageActionHandler } from '../src/actions/types';

const INTERNAL_TOKEN = 'test-internal-token';
const TEST_WORKSPACE = '00000000-0000-4000-8000-000000000001';
const TEST_USER = '00000000-0000-4000-8000-000000000002';
const TEST_API_KEY_ID = '00000000-0000-4000-8000-000000000003';
const TEST_API_KEY_PREFIX = '0a1b2c3d';

const capture: {
  ctx: ActionContext | null;
  payload: unknown;
} = {
  ctx: null,
  payload: null,
};
const TEST_ACTION_KEY: StorageActionKey = 'platform.storage.objects.read';

function readCapturedCtx(): ActionContext | null {
  return capture.ctx;
}
function readCapturedPayload(): unknown {
  return capture.payload;
}

beforeAll(() => {
  __resetRegistry();
  const handler: StorageActionHandler = (payload, ctx) => {
    capture.ctx = ctx;
    capture.payload = payload;
    return { echoed: true };
  };
  registerHandler(TEST_ACTION_KEY, handler);
});

afterAll(() => {
  __resetRegistry();
});

function buildTestApp(): { app: ReturnType<typeof buildApp>; config: ServiceConfig } {
  const config = loadConfig({
    ...process.env,
    INTERNAL_SERVICE_TOKEN: INTERNAL_TOKEN,
    INTERNAL_AUTH_MODE: 'hybrid',
  });
  return { app: buildApp(config), config };
}

describe('GET /health', () => {
  test('returns 200 ok', async () => {
    const { app } = buildTestApp();
    const res = await app.request('/health', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; service: string };
    expect(body).toEqual({ ok: true, service: 'storage-service' });
  });
});

describe('GET /ready', () => {
  test('returns 200 ok with empty deps in STORAGE-4', async () => {
    const { app } = buildTestApp();
    const res = await app.request('/ready', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; deps: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.deps).toEqual({});
  });
});

describe('POST /internal/storage-actions — auth', () => {
  test('rejects missing X-Internal-Service-Token with 401', async () => {
    const { app } = buildTestApp();
    const res = await app.request('/internal/storage-actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actionKey: TEST_ACTION_KEY, payload: {} }),
    });
    expect(res.status).toBe(401);
  });

  test('rejects wrong X-Internal-Service-Token with 403', async () => {
    const { app } = buildTestApp();
    const res = await app.request('/internal/storage-actions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Internal-Service-Token': 'wrong-token',
      },
      body: JSON.stringify({ actionKey: TEST_ACTION_KEY, payload: {} }),
    });
    expect(res.status).toBe(403);
  });

  test('returns 500 when INTERNAL_SERVICE_TOKEN env is missing', async () => {
    const config = loadConfig({ ...process.env, INTERNAL_SERVICE_TOKEN: '' });
    const app = buildApp(config);
    const res = await app.request('/internal/storage-actions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Internal-Service-Token': 'anything',
      },
      body: JSON.stringify({ actionKey: TEST_ACTION_KEY, payload: {} }),
    });
    expect(res.status).toBe(500);
  });
});

function authHeaders(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    'content-type': 'application/json',
    'X-Internal-Service-Token': INTERNAL_TOKEN,
    'X-Workspace-Id': TEST_WORKSPACE,
    'X-XS-User-Id': TEST_USER,
    'X-XS-Actor-Type': 'user',
    ...overrides,
  };
}

describe('POST /internal/storage-actions — envelope + actor parsing', () => {
  test('happy path with a user actor returns 200 + captures ctx', async () => {
    const { app } = buildTestApp();
    capture.ctx = null;
    capture.payload = null;
    const res = await app.request('/internal/storage-actions', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ actionKey: TEST_ACTION_KEY, payload: { q: 'list' } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: unknown };
    expect(body.ok).toBe(true);
    expect(body.data).toEqual({ echoed: true });
    expect(readCapturedPayload()).toEqual({ q: 'list' });
    const ctx = readCapturedCtx();
    expect(ctx).not.toBeNull();
    expect(ctx?.workspaceId).toBe(TEST_WORKSPACE);
    expect(ctx?.actor.kind).toBe('user');
    if (ctx?.actor.kind === 'user') {
      expect(ctx.actor.userId).toBe(TEST_USER);
    }
    expect(ctx?.userId).toBe(TEST_USER);
  });

  test('api_key actor populates ctx.actor and leaves ctx.userId undefined', async () => {
    const { app } = buildTestApp();
    capture.ctx = null;
    capture.payload = null;
    const res = await app.request('/internal/storage-actions', {
      method: 'POST',
      headers: authHeaders({
        'X-XS-Actor-Type': 'api_key',
        'X-XS-API-Key-Id': TEST_API_KEY_ID,
        'X-XS-API-Key-Prefix': TEST_API_KEY_PREFIX,
        'X-XS-User-Id': '',
      }),
      body: JSON.stringify({ actionKey: TEST_ACTION_KEY, payload: {} }),
    });
    expect(res.status).toBe(200);
    const ctx = readCapturedCtx();
    expect(ctx?.actor.kind).toBe('api_key');
    if (ctx?.actor.kind === 'api_key') {
      expect(ctx.actor.apiKeyId).toBe(TEST_API_KEY_ID);
      expect(ctx.actor.keyPrefix).toBe(TEST_API_KEY_PREFIX);
    }
    expect(ctx?.userId).toBeUndefined();
  });

  test('rejects unknown X-XS-Actor-Type with 400 INVALID_HEADER', async () => {
    const { app } = buildTestApp();
    const res = await app.request('/internal/storage-actions', {
      method: 'POST',
      headers: authHeaders({ 'X-XS-Actor-Type': 'service' }),
      body: JSON.stringify({ actionKey: TEST_ACTION_KEY, payload: {} }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.error.code).toBe('INVALID_HEADER');
  });

  test('api_key actor without X-XS-API-Key-Id returns 400', async () => {
    const { app } = buildTestApp();
    const res = await app.request('/internal/storage-actions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Internal-Service-Token': INTERNAL_TOKEN,
        'X-Workspace-Id': TEST_WORKSPACE,
        'X-XS-Actor-Type': 'api_key',
        'X-XS-API-Key-Prefix': TEST_API_KEY_PREFIX,
      },
      body: JSON.stringify({ actionKey: TEST_ACTION_KEY, payload: {} }),
    });
    expect(res.status).toBe(400);
  });

  test('api_key actor with non-UUID X-XS-API-Key-Id returns 400', async () => {
    const { app } = buildTestApp();
    const res = await app.request('/internal/storage-actions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Internal-Service-Token': INTERNAL_TOKEN,
        'X-Workspace-Id': TEST_WORKSPACE,
        'X-XS-Actor-Type': 'api_key',
        'X-XS-API-Key-Id': 'not-a-uuid',
        'X-XS-API-Key-Prefix': TEST_API_KEY_PREFIX,
      },
      body: JSON.stringify({ actionKey: TEST_ACTION_KEY, payload: {} }),
    });
    expect(res.status).toBe(400);
  });

  test('api_key actor without X-XS-API-Key-Prefix returns 400', async () => {
    const { app } = buildTestApp();
    const res = await app.request('/internal/storage-actions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Internal-Service-Token': INTERNAL_TOKEN,
        'X-Workspace-Id': TEST_WORKSPACE,
        'X-XS-Actor-Type': 'api_key',
        'X-XS-API-Key-Id': TEST_API_KEY_ID,
      },
      body: JSON.stringify({ actionKey: TEST_ACTION_KEY, payload: {} }),
    });
    expect(res.status).toBe(400);
  });

  test('api_key actor with wrong-length prefix returns 400', async () => {
    const { app } = buildTestApp();
    const res = await app.request('/internal/storage-actions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Internal-Service-Token': INTERNAL_TOKEN,
        'X-Workspace-Id': TEST_WORKSPACE,
        'X-XS-Actor-Type': 'api_key',
        'X-XS-API-Key-Id': TEST_API_KEY_ID,
        'X-XS-API-Key-Prefix': 'TOOLONGHEX',
      },
      body: JSON.stringify({ actionKey: TEST_ACTION_KEY, payload: {} }),
    });
    expect(res.status).toBe(400);
  });

  test('user actor without X-XS-User-Id returns 401', async () => {
    const { app } = buildTestApp();
    const res = await app.request('/internal/storage-actions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Internal-Service-Token': INTERNAL_TOKEN,
        'X-Workspace-Id': TEST_WORKSPACE,
      },
      body: JSON.stringify({ actionKey: TEST_ACTION_KEY, payload: {} }),
    });
    expect(res.status).toBe(401);
  });

  test('user actor with non-UUID X-XS-User-Id returns 400', async () => {
    const { app } = buildTestApp();
    const res = await app.request('/internal/storage-actions', {
      method: 'POST',
      headers: authHeaders({ 'X-XS-User-Id': 'not-a-uuid' }),
      body: JSON.stringify({ actionKey: TEST_ACTION_KEY, payload: {} }),
    });
    expect(res.status).toBe(400);
  });

  test('missing X-Workspace-Id returns 400 MISSING_HEADER', async () => {
    const { app } = buildTestApp();
    const res = await app.request('/internal/storage-actions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Internal-Service-Token': INTERNAL_TOKEN,
        'X-XS-User-Id': TEST_USER,
      },
      body: JSON.stringify({ actionKey: TEST_ACTION_KEY, payload: {} }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.error.code).toBe('MISSING_HEADER');
  });

  test('non-UUID X-Workspace-Id returns 400 INVALID_HEADER', async () => {
    const { app } = buildTestApp();
    const res = await app.request('/internal/storage-actions', {
      method: 'POST',
      headers: authHeaders({ 'X-Workspace-Id': 'nope' }),
      body: JSON.stringify({ actionKey: TEST_ACTION_KEY, payload: {} }),
    });
    expect(res.status).toBe(400);
  });

  test('unknown actionKey returns 400 UNKNOWN_ACTION', async () => {
    const { app } = buildTestApp();
    const res = await app.request('/internal/storage-actions', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ actionKey: 'unknown.action.key', payload: {} }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.error.code).toBe('UNKNOWN_ACTION');
  });

  test('malformed JSON body returns 400 INVALID_BODY', async () => {
    const { app } = buildTestApp();
    const res = await app.request('/internal/storage-actions', {
      method: 'POST',
      headers: authHeaders(),
      body: 'not-json',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.error.code).toBe('INVALID_BODY');
  });

  test('envelope missing actionKey returns 400 VALIDATION_ERROR', async () => {
    const { app } = buildTestApp();
    const res = await app.request('/internal/storage-actions', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ payload: {} }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  test('response carries X-Request-Id', async () => {
    const { app } = buildTestApp();
    const res = await app.request('/internal/storage-actions', {
      method: 'POST',
      headers: authHeaders({ 'X-Request-Id': 'corr-id-fixture' }),
      body: JSON.stringify({ actionKey: TEST_ACTION_KEY, payload: {} }),
    });
    expect(res.headers.get('X-Request-Id')).toBe('corr-id-fixture');
  });
});
