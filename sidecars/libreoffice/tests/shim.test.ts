/**
 * STORAGE-FU-5-FU-G — Bun.serve fetch-handler tests.
 *
 * Exercises the full request → response pipeline against in-memory
 * fakes. No `Bun.serve`, no real soffice, no real filesystem — but
 * the handler shape is the same one that `boot()` wires into
 * `Bun.serve` in production.
 */
import { describe, expect, test } from 'bun:test';

import { buildFetchHandler, type BuildHandlerDeps } from '../src/shim';
import { createHealthChecker } from '../src/health';
import type { ConvertDeps, FsPort, SofficeRunner } from '../src/convert';
import { pngBytesForTest } from './_test-helpers';

function makeOkFs(outputBytes: Uint8Array): FsPort {
  return {
    async mkdtemp(prefix) {
      return `${prefix}fake`;
    },
    async writeFile() {},
    async readFile() {
      return outputBytes;
    },
    async readdir() {
      return ['in.png'];
    },
    async rm() {},
  };
}

const okRunner: SofficeRunner = {
  async run() {
    return { exitCode: 0, timedOut: false };
  },
};

const failingRunner: SofficeRunner = {
  async run() {
    return { exitCode: 1, timedOut: false };
  },
};

const timingOutRunner: SofficeRunner = {
  async run() {
    return { exitCode: -1, timedOut: true };
  },
};

function buildDeps(overrides: Partial<BuildHandlerDeps> = {}): BuildHandlerDeps {
  const fs = overrides.fs ?? makeOkFs(pngBytesForTest(800, 1100));
  const soffice = overrides.soffice ?? okRunner;
  const convertDeps: ConvertDeps = {
    fs,
    soffice,
    tmpRoot: '/tmp',
    timeoutMs: 30_000,
    newId: () => 'fake',
  };
  return {
    fs,
    soffice,
    tmpRoot: '/tmp',
    timeoutMs: 30_000,
    newId: () => 'fake',
    health: overrides.health ?? createHealthChecker(convertDeps),
    debug: overrides.debug ?? false,
    log: overrides.log,
    ...overrides,
  };
}

function buildConvertRequest(body: unknown, init: RequestInit = {}): Request {
  return new Request('http://localhost/convert', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...init,
  });
}

// ── POST /convert — happy path ─────────────────────────────────────────

describe('POST /convert — happy path', () => {
  test('returns 200 with image/png + X-Document-Page-* headers', async () => {
    const handler = buildFetchHandler(buildDeps());
    const req = buildConvertRequest({
      sourceContentType: 'application/pdf',
      bytes: Buffer.from([0x25, 0x50, 0x44, 0x46]).toString('base64'),
    });
    const res = await handler(req);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-document-page-width')).toBe('800');
    expect(res.headers.get('x-document-page-height')).toBe('1100');
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.byteLength).toBeGreaterThan(8);
    // First 8 bytes are the PNG magic.
    expect(body.slice(0, 8)).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  test('omits X-Document-Page-* headers when dimensions are null', async () => {
    // Build an output PNG with under-24-byte length — magic passes,
    // dim parse returns nulls.
    const tinyPng = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    ]);
    const handler = buildFetchHandler(buildDeps({ fs: makeOkFs(tinyPng) }));
    const req = buildConvertRequest({
      sourceContentType: 'application/pdf',
      bytes: Buffer.from('hi').toString('base64'),
    });
    const res = await handler(req);
    expect(res.status).toBe(200);
    expect(res.headers.has('x-document-page-width')).toBe(false);
    expect(res.headers.has('x-document-page-height')).toBe(false);
  });
});

// ── POST /convert — error paths ────────────────────────────────────────

describe('POST /convert — error paths', () => {
  test('INVALID_JSON → 400', async () => {
    const handler = buildFetchHandler(buildDeps());
    const req = buildConvertRequest('not json');
    const res = await handler(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({
      code: 'INVALID_JSON',
      message: expect.any(String),
    });
  });

  test('MISSING_FIELD → 400', async () => {
    const handler = buildFetchHandler(buildDeps());
    const req = buildConvertRequest({ sourceContentType: 'application/pdf' });
    const res = await handler(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('MISSING_FIELD');
  });

  test('INVALID_BASE64 → 400', async () => {
    const handler = buildFetchHandler(buildDeps());
    const req = buildConvertRequest({
      sourceContentType: 'application/pdf',
      bytes: '!!!not-base64!!!',
    });
    const res = await handler(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_BASE64');
  });

  test('UNSUPPORTED_FORMAT (off-list MIME) → 415', async () => {
    const handler = buildFetchHandler(buildDeps());
    const req = buildConvertRequest({
      sourceContentType: 'image/png',
      bytes: Buffer.from('hi').toString('base64'),
    });
    const res = await handler(req);
    expect(res.status).toBe(415);
    const body = await res.json();
    expect(body.code).toBe('UNSUPPORTED_FORMAT');
  });

  test('OVER_MAX_BYTES (declared Content-Length pre-reject) → 413', async () => {
    const handler = buildFetchHandler(buildDeps());
    // Declare a content-length over the cap; body content doesn't
    // matter because the handler short-circuits before parsing.
    const req = new Request('http://localhost/convert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(200 * 1024 * 1024), // 200 MiB
      },
      body: '{}',
    });
    const res = await handler(req);
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.code).toBe('OVER_MAX_BYTES');
  });

  test('CONVERT_FAILED (soffice non-zero exit) → 500', async () => {
    const handler = buildFetchHandler(buildDeps({ soffice: failingRunner }));
    const req = buildConvertRequest({
      sourceContentType: 'application/pdf',
      bytes: Buffer.from('hi').toString('base64'),
    });
    const res = await handler(req);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe('CONVERT_FAILED');
  });

  test('TIMEOUT → 504', async () => {
    const handler = buildFetchHandler(buildDeps({ soffice: timingOutRunner }));
    const req = buildConvertRequest({
      sourceContentType: 'application/pdf',
      bytes: Buffer.from('hi').toString('base64'),
    });
    const res = await handler(req);
    expect(res.status).toBe(504);
    const body = await res.json();
    expect(body.code).toBe('TIMEOUT');
  });

  test('failure responses contain ONLY the closed-set envelope', async () => {
    const handler = buildFetchHandler(buildDeps({ soffice: failingRunner }));
    const req = buildConvertRequest({
      sourceContentType: 'application/pdf',
      bytes: Buffer.from('payload').toString('base64'),
    });
    const res = await handler(req);
    const body = await res.json();
    // Exactly the documented keys — NO stderr, NO library text, NO paths.
    expect(Object.keys(body).sort()).toEqual(['code', 'message']);
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain('/tmp');
    expect(serialised).not.toContain('soffice');
    expect(serialised).not.toContain('libreoffice');
    expect(serialised).not.toContain('xynes_live_');
    expect(serialised).not.toContain('AKIA');
    expect(serialised).not.toContain('X-Amz-Signature');
  });
});

// ── GET /health ────────────────────────────────────────────────────────

describe('GET /health', () => {
  test('returns 200 + { status: "ok" } when probe succeeds', async () => {
    const handler = buildFetchHandler(buildDeps());
    const res = await handler(new Request('http://localhost/health'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'ok' });
  });

  test('returns 503 + { status: "degraded" } when probe fails', async () => {
    const handler = buildFetchHandler(buildDeps({ soffice: failingRunner }));
    const res = await handler(new Request('http://localhost/health'));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ status: 'degraded' });
  });

  test('CONVERT_FAILED invalidates the health cache', async () => {
    let runCount = 0;
    const flakyRunner: SofficeRunner = {
      async run() {
        runCount++;
        // First call (the health probe at boot) succeeds; second call
        // (the user request that triggers CONVERT_FAILED) fails; third
        // call (the next /health probe after invalidation) re-runs.
        if (runCount === 2) return { exitCode: 1, timedOut: false };
        return { exitCode: 0, timedOut: false };
      },
    };
    const handler = buildFetchHandler(buildDeps({ soffice: flakyRunner }));
    // 1st health probe — caches success.
    const r1 = await handler(new Request('http://localhost/health'));
    expect(r1.status).toBe(200);
    // CONVERT_FAILED — invalidates the cache.
    const r2 = await handler(
      buildConvertRequest({
        sourceContentType: 'application/pdf',
        bytes: Buffer.from('hi').toString('base64'),
      }),
    );
    expect(r2.status).toBe(500);
    // 3rd health probe — re-runs (would have used cache otherwise).
    await handler(new Request('http://localhost/health'));
    expect(runCount).toBe(3);
  });
});

// ── 404 / method mismatch ──────────────────────────────────────────────

describe('unknown routes', () => {
  test('GET /unknown → 404 empty', async () => {
    const handler = buildFetchHandler(buildDeps());
    const res = await handler(new Request('http://localhost/unknown'));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('');
  });

  test('POST /health → 404 (wrong method)', async () => {
    const handler = buildFetchHandler(buildDeps());
    const res = await handler(new Request('http://localhost/health', { method: 'POST' }));
    expect(res.status).toBe(404);
  });

  test('GET /convert → 404 (wrong method)', async () => {
    const handler = buildFetchHandler(buildDeps());
    const res = await handler(new Request('http://localhost/convert'));
    expect(res.status).toBe(404);
  });
});

// ── debug logging ──────────────────────────────────────────────────────

describe('debug logging', () => {
  test('emits a single redacted log line per request when debug=true', async () => {
    const logs: string[] = [];
    const handler = buildFetchHandler(
      buildDeps({ debug: true, log: (line) => logs.push(line) }),
    );
    await handler(
      buildConvertRequest({
        sourceContentType: 'application/pdf',
        bytes: Buffer.from('hi').toString('base64'),
      }),
    );
    // shim.convert event
    const convertLogs = logs.filter((l) => l.includes('shim.convert'));
    expect(convertLogs).toHaveLength(1);
    const parsed = JSON.parse(convertLogs[0]!);
    expect(parsed).toMatchObject({
      event: 'shim.convert',
      status: 200,
      contentType: 'image/png',
      outcome: 'success',
    });
    // STORAGE-9: the log line MUST NOT carry the request bytes or
    // any library hint.
    expect(convertLogs[0]).not.toContain('aGk='); // base64 of 'hi'
    expect(convertLogs[0]).not.toContain('soffice');
    expect(convertLogs[0]).not.toContain('/tmp');
  });

  test('debug=false emits zero per-request log lines', async () => {
    const logs: string[] = [];
    const handler = buildFetchHandler(
      buildDeps({ debug: false, log: (line) => logs.push(line) }),
    );
    await handler(
      buildConvertRequest({
        sourceContentType: 'application/pdf',
        bytes: Buffer.from('hi').toString('base64'),
      }),
    );
    expect(logs.filter((l) => l.includes('shim.convert'))).toHaveLength(0);
  });
});
