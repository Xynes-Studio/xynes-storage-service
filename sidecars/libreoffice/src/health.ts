/**
 * STORAGE-FU-5-FU-G — Health probe handler.
 *
 * `GET /health` returns 200 `{ status: "ok" }` when the shim has
 * successfully completed a one-shot soffice probe at boot OR the
 * runtime cache says it's healthy. Returns 503 `{ status: "degraded" }`
 * when the boot probe failed or the cache reflects a recent crash.
 *
 * The probe runs the same convert pipeline as `POST /convert` but
 * with a tiny synthetic RTF input — keeps the probe cheap (~200 ms
 * after warm) and exercises the same soffice argv that real requests
 * will take.
 *
 * The result is cached for `HEALTH_CACHE_TTL_MS` so a stampede of
 * probes can't peg the sidecar.
 */
import { runConvert, type ConvertDeps } from './convert';

export const HEALTH_CACHE_TTL_MS = 15_000; // 15 s
export const HEALTH_PROBE_TIMEOUT_MS = 30_000; // 30 s — generous for cold soffice

export type HealthStatus = 'ok' | 'degraded';

export interface HealthSnapshot {
  readonly status: HealthStatus;
  readonly checkedAt: number;
}

/**
 * Minimal RTF document — soffice can render this without external
 * fonts in <500 ms on a warm process. We use RTF (not PDF) because
 * RTF avoids the Draw/Impress import pipeline which is slower.
 */
const HEALTH_PROBE_RTF =
  '{\\rtf1\\ansi\\ansicpg1252\\deff0\\nouicompat{\\fonttbl{\\f0\\fnil\\fcharset0 Calibri;}}{\\*\\generator xynes-libreoffice-sidecar 0.1.0}\\viewkind4\\uc1\\pard\\sa200\\sl276\\slmult1\\f0\\fs22\\lang9 OK\\par}';

const HEALTH_PROBE_INPUT = {
  sourceContentType: 'application/rtf',
  bytes: new TextEncoder().encode(HEALTH_PROBE_RTF),
} as const;

/**
 * Run a one-shot health probe and return the resulting snapshot. The
 * caller is responsible for caching — see `createHealthChecker`.
 *
 * The injected `now` lets tests inject a deterministic clock without
 * stubbing `Date.now()`. Defaults to wall-clock time.
 */
export async function probeOnce(
  deps: ConvertDeps,
  now: () => number = () => Date.now(),
): Promise<HealthSnapshot> {
  const checkedAt = now();
  try {
    const result = await runConvert(
      { sourceContentType: HEALTH_PROBE_INPUT.sourceContentType, bytes: HEALTH_PROBE_INPUT.bytes },
      { ...deps, timeoutMs: HEALTH_PROBE_TIMEOUT_MS },
    );
    if (result.ok) {
      return { status: 'ok', checkedAt };
    }
    return { status: 'degraded', checkedAt };
  } catch {
    return { status: 'degraded', checkedAt };
  }
}

export interface HealthChecker {
  readonly current: () => HealthSnapshot | null;
  readonly check: () => Promise<HealthSnapshot>;
  readonly invalidate: () => void;
}

/**
 * Wrap `probeOnce` with a TTL cache so concurrent probes share one
 * underlying soffice run. The cache is invalidated by
 * `invalidate()` — the convert handler calls this whenever a
 * conversion fails in a way that suggests the sidecar may be sick
 * (CONVERT_FAILED, TIMEOUT) so the next probe rechecks.
 *
 * Time source is injectable so tests can advance time without
 * `await new Promise(setTimeout)`.
 */
export function createHealthChecker(
  deps: ConvertDeps,
  options?: { now?: () => number; ttlMs?: number },
): HealthChecker {
  const now = options?.now ?? (() => Date.now());
  const ttl = options?.ttlMs ?? HEALTH_CACHE_TTL_MS;

  let cached: HealthSnapshot | null = null;
  let inflight: Promise<HealthSnapshot> | null = null;

  function isFresh(snapshot: HealthSnapshot): boolean {
    return now() - snapshot.checkedAt < ttl;
  }

  async function check(): Promise<HealthSnapshot> {
    if (cached && isFresh(cached)) return cached;
    if (inflight) return inflight;
    inflight = probeOnce(deps, now)
      .then((snapshot) => {
        cached = snapshot;
        return snapshot;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  return {
    current: () => cached,
    check,
    invalidate: () => {
      cached = null;
    },
  };
}
