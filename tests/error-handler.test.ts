/**
 * Error handler integration tests.
 *
 * Register a handler that throws each error family and assert the canonical
 * envelope is emitted with the right status code + redacted message.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/infra/config';
import { __resetRegistry, registerHandler } from '../src/actions/registry';
import { ProviderAdapterError } from '../src/infra/providers/errors';
import type { StorageActionHandler, StorageActionKey } from '../src/actions/types';

const INTERNAL_TOKEN = 'test-internal-token';
const WS = '00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-000000000002';
const ACTION_KEY: StorageActionKey = 'platform.storage.objects.read';

let throwAction: () => never = () => {
  throw new Error('not configured');
};

beforeAll(() => {
  __resetRegistry();
  const handler: StorageActionHandler = () => {
    throwAction();
    return null;
  };
  registerHandler(ACTION_KEY, handler);
});

afterAll(() => {
  __resetRegistry();
});

function buildTestApp() {
  const config = loadConfig({
    ...process.env,
    INTERNAL_SERVICE_TOKEN: INTERNAL_TOKEN,
  });
  return buildApp(config);
}

function headers() {
  return {
    'content-type': 'application/json',
    'X-Internal-Service-Token': INTERNAL_TOKEN,
    'X-Workspace-Id': WS,
    'X-XS-User-Id': USER,
  };
}

describe('error handler — ProviderAdapterError mapping', () => {
  test('PROVIDER_OPERATION_FAILED → 502 BAD_GATEWAY-ish envelope', async () => {
    throwAction = () => {
      throw new ProviderAdapterError('PROVIDER_OPERATION_FAILED');
    };
    const app = buildTestApp();
    const res = await app.request('/internal/storage-actions', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ actionKey: ACTION_KEY, payload: {} }),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { ok: boolean; error: { code: string; message: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('PROVIDER_OPERATION_FAILED');
    // Message is the safe default — no credentials, no signature parameter.
    expect(body.error.message.toLowerCase()).not.toContain('accesskey');
    expect(body.error.message.toLowerCase()).not.toContain('secret');
    expect(body.error.message.toLowerCase()).not.toContain('x-amz-signature');
  });

  test('PROVIDER_OBJECT_KEY_INVALID with override statusHint 400 → 400', async () => {
    throwAction = () => {
      throw new ProviderAdapterError(
        'PROVIDER_OBJECT_KEY_INVALID',
        'Object key contains a forbidden character',
        400,
      );
    };
    const app = buildTestApp();
    const res = await app.request('/internal/storage-actions', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ actionKey: ACTION_KEY, payload: {} }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.error.code).toBe('PROVIDER_OBJECT_KEY_INVALID');
  });
});

describe('error handler — ZodError mapping', () => {
  test('handler-thrown ZodError → 400 VALIDATION_ERROR', async () => {
    let realZodError: unknown;
    try {
      z.object({ x: z.string() }).strict().parse({ x: 123 });
    } catch (err) {
      realZodError = err;
    }
    throwAction = () => {
      throw realZodError as Error;
    };
    const app = buildTestApp();
    const res = await app.request('/internal/storage-actions', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ actionKey: ACTION_KEY, payload: {} }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      ok: boolean;
      error: { code: string; details?: unknown };
    };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details).toBeDefined();
  });
});

describe('error handler — unknown error mapping', () => {
  test('unknown Error → 500 INTERNAL_ERROR with safe message', async () => {
    throwAction = () => {
      throw new Error('Sensitive raw provider message AKIA-LEAK-1234');
    };
    const app = buildTestApp();
    const res = await app.request('/internal/storage-actions', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ actionKey: ACTION_KEY, payload: {} }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; error: { code: string; message: string } };
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe('Internal server error');
    // The raw message MUST NOT leak through.
    expect(body.error.message).not.toContain('AKIA-LEAK-1234');
  });
});
