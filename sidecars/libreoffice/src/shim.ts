/**
 * STORAGE-FU-5-FU-G — LibreOffice sidecar HTTP shim entry point.
 *
 * Wires `Bun.serve` with two routes:
 *
 *   POST /convert  → runConvert(...)  (see convert.ts)
 *   GET  /health   → healthChecker    (see health.ts)
 *
 * Every other path returns 404 with an empty body. Bodies that
 * exceed `MAX_REQUEST_BODY_BYTES` are rejected with 413 BEFORE any
 * JSON parsing.
 *
 * Production wiring uses `defaultSofficeRunner` (from soffice-runner.ts)
 * and `node:fs/promises` (from defaultFs below). The shim runs as
 * `uid=10001` (configured in the Dockerfile) — no shell login, no
 * filesystem writes outside `/tmp` (tmpfs).
 *
 * Logs:
 *
 *   - Boot:    `{ event: 'shim.boot', port, tmpRoot, timeoutMs }` (one line)
 *   - Health:  `{ event: 'shim.health', status }` (per probe completion)
 *   - Convert: NO per-request log lines by default. Request payloads
 *     and result envelopes contain raw document bytes; reflecting any
 *     of that into stdout would violate STORAGE-9 redaction. If
 *     debug logs are needed, the operator sets STORAGE_SIDECAR_DEBUG=1
 *     which enables a single redacted line per request (status code +
 *     content-type only).
 */
import * as nodeFs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { runConvert, type ConvertDeps, type FsPort } from './convert';
import { buildErrorBody, SHIM_ERROR_CODES, SHIM_ERROR_STATUS, type ShimErrorCode } from './errors';
import { createHealthChecker, type HealthChecker } from './health';
import { MAX_REQUEST_BODY_BYTES, parseConvertRequest } from './parse-request';
import { defaultSofficeRunner } from './soffice-runner';

// ── Adapt node:fs/promises to FsPort ────────────────────────────────────

export const defaultFs: FsPort = {
  mkdtemp: (prefix) => nodeFs.mkdtemp(prefix),
  writeFile: (path, data) => nodeFs.writeFile(path, data),
  readFile: async (path) => new Uint8Array(await nodeFs.readFile(path)),
  readdir: (path) => nodeFs.readdir(path),
  rm: (path, options) => nodeFs.rm(path, options),
};

// ── Server entry ────────────────────────────────────────────────────────

export interface ShimConfig {
  readonly port: number;
  readonly hostname: string;
  readonly tmpRoot: string;
  readonly timeoutMs: number;
  readonly debug: boolean;
}

/**
 * Resolve runtime config from env. ALL defaults are safe — a
 * misconfigured deploy still boots; bad values fall back rather than
 * crash.
 */
export function resolveConfig(env: NodeJS.ProcessEnv = process.env): ShimConfig {
  const port = parsePositiveInt(env.STORAGE_SIDECAR_PORT) ?? 8100;
  const hostname = (env.STORAGE_SIDECAR_HOSTNAME ?? '0.0.0.0').trim() || '0.0.0.0';
  const tmpRoot = (env.STORAGE_SIDECAR_TMP_ROOT ?? '/tmp').trim() || '/tmp';
  // Per-request timeout. Default 55 s — under the FU-C client default
  // 60 s so the sidecar surfaces a TIMEOUT (504) before FU-C's
  // AbortController fires.
  const timeoutMs = parsePositiveInt(env.STORAGE_SIDECAR_TIMEOUT_MS) ?? 55_000;
  const debug = env.STORAGE_SIDECAR_DEBUG === '1';
  return { port, hostname, tmpRoot, timeoutMs, debug };
}

function parsePositiveInt(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

// ── Request handler ─────────────────────────────────────────────────────

export interface BuildHandlerDeps {
  readonly fs: FsPort;
  readonly soffice: ConvertDeps['soffice'];
  readonly tmpRoot: string;
  readonly timeoutMs: number;
  readonly newId: () => string;
  readonly health: HealthChecker;
  readonly debug: boolean;
  readonly log?: (line: string) => void;
}

/**
 * Build the per-request handler. Pure — every dependency is injected
 * so the unit tests can spin one up without touching `Bun.serve` or
 * the filesystem.
 */
export function buildFetchHandler(deps: BuildHandlerDeps): (req: Request) => Promise<Response> {
  const convertDeps: ConvertDeps = {
    fs: deps.fs,
    soffice: deps.soffice,
    tmpRoot: deps.tmpRoot,
    timeoutMs: deps.timeoutMs,
    newId: deps.newId,
  };
  const log = deps.log ?? ((line: string) => console.log(line));

  return async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // ── GET /health ────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/health') {
      try {
        const snapshot = await deps.health.check();
        const status = snapshot.status === 'ok' ? 200 : 503;
        if (deps.debug) {
          log(JSON.stringify({ event: 'shim.health', status: snapshot.status }));
        }
        return jsonResponse(status, { status: snapshot.status });
      } catch {
        return jsonResponse(503, { status: 'degraded' });
      }
    }

    // ── POST /convert ──────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/convert') {
      // Cheap pre-parse length check: reject obviously-oversize bodies
      // before reading them into memory.
      const declaredLength = req.headers.get('content-length');
      if (declaredLength) {
        const n = Number(declaredLength);
        if (Number.isFinite(n) && n > MAX_REQUEST_BODY_BYTES) {
          return shimErrorResponse(SHIM_ERROR_CODES.OVER_MAX_BYTES);
        }
      }

      let bodyText: string;
      try {
        bodyText = await req.text();
      } catch {
        return shimErrorResponse(SHIM_ERROR_CODES.INVALID_JSON);
      }
      if (bodyText.length > MAX_REQUEST_BODY_BYTES) {
        return shimErrorResponse(SHIM_ERROR_CODES.OVER_MAX_BYTES);
      }

      const parsed = parseConvertRequest(bodyText);
      if (!parsed.ok) {
        return shimErrorResponse(parsed.code);
      }

      const result = await runConvert(parsed.value, convertDeps);

      if (deps.debug) {
        const status = result.ok ? 200 : SHIM_ERROR_STATUS[result.code];
        log(
          JSON.stringify({
            event: 'shim.convert',
            status,
            contentType: result.ok ? result.contentType : null,
            outcome: result.ok ? 'success' : result.code,
          }),
        );
      }

      if (!result.ok) {
        // Mark health stale so the next probe re-runs the one-shot
        // RTF conversion. A persistent backend failure will then flip
        // /health to 503.
        if (
          result.code === SHIM_ERROR_CODES.CONVERT_FAILED ||
          result.code === SHIM_ERROR_CODES.TIMEOUT
        ) {
          deps.health.invalidate();
        }
        return shimErrorResponse(result.code);
      }

      const headers: Record<string, string> = {
        'Content-Type': result.contentType,
        'Cache-Control': 'no-store',
      };
      if (result.width !== null) headers['X-Document-Page-Width'] = String(result.width);
      if (result.height !== null) headers['X-Document-Page-Height'] = String(result.height);
      // `Uint8Array` is a valid BodyInit at runtime in Bun + the
      // Fetch spec, but the strict DOM typings treat it as
      // `ArrayBuffer | SharedArrayBuffer` (Uint8Array's `.buffer`
      // can be either). Cast to BodyInit explicitly — the runtime
      // contract is well-defined.
      return new Response(result.bytes as unknown as BodyInit, { status: 200, headers });
    }

    // ── Anything else ──────────────────────────────────────────────────
    return new Response(null, { status: 404 });
  };
}

function shimErrorResponse(code: ShimErrorCode): Response {
  return jsonResponse(SHIM_ERROR_STATUS[code], buildErrorBody(code));
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// ── Boot ────────────────────────────────────────────────────────────────

/** Server handle returned by the `serve` function. */
export interface ServerHandle {
  stop(): void;
}

/** Inject-able server factory — production wiring uses `Bun.serve`. */
export type ServeFn = (options: {
  port: number;
  hostname: string;
  maxRequestBodySize?: number;
  fetch: (req: Request) => Promise<Response> | Response;
  error: (err: Error) => Response;
}) => ServerHandle;

const defaultServe: ServeFn = (options) => {
  // Bun.serve is a runtime global. Cast keeps the file compilable
  // under `tsc --noEmit`. Tests pass a fake `serve` via BootOptions.
  const bun = (globalThis as { Bun?: { serve: ServeFn } }).Bun;
  if (!bun) {
    throw new Error('Bun.serve is required; pass options.serve in tests.');
  }
  return bun.serve(options);
};

export interface BootOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly fs?: FsPort;
  readonly soffice?: ConvertDeps['soffice'];
  readonly log?: (line: string) => void;
  /** Injected server factory. Defaults to `Bun.serve`. */
  readonly serve?: ServeFn;
}

export function boot(options: BootOptions = {}): { stop: () => void; config: ShimConfig } {
  const config = resolveConfig(options.env ?? process.env);
  const fs = options.fs ?? defaultFs;
  const soffice = options.soffice ?? defaultSofficeRunner;
  const log = options.log ?? ((line: string) => console.log(line));
  const serve = options.serve ?? defaultServe;

  const health = createHealthChecker({
    fs,
    soffice,
    tmpRoot: config.tmpRoot,
    timeoutMs: config.timeoutMs,
    newId: randomUUID,
  });

  const fetchHandler = buildFetchHandler({
    fs,
    soffice,
    tmpRoot: config.tmpRoot,
    timeoutMs: config.timeoutMs,
    newId: randomUUID,
    health,
    debug: config.debug,
    log,
  });

  const server = serve({
    port: config.port,
    hostname: config.hostname,
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    fetch: fetchHandler,
    error: () => jsonResponse(500, buildErrorBody(SHIM_ERROR_CODES.INTERNAL_ERROR)),
  });

  log(
    JSON.stringify({
      event: 'shim.boot',
      port: config.port,
      hostname: config.hostname,
      tmpRoot: config.tmpRoot,
      timeoutMs: config.timeoutMs,
      debug: config.debug,
    }),
  );

  // Kick off the initial health probe in the background. The first
  // /health request that arrives before this completes will see the
  // in-flight promise via the health checker's cache.
  health.check().catch(() => {
    /* swallowed — the probe result lands in the cache and the next /health surfaces it */
  });

  return {
    stop: () => server.stop(),
    config,
  };
}

// Auto-boot when invoked as the entry point. Bun runs `src/shim.ts`
// as the CMD per the Dockerfile.
if (import.meta.main) {
  boot();
}
