import { Hono } from 'hono';

/**
 * Readiness probe.
 *
 * STORAGE-4 ships with a deps-less probe — DB / queue readiness checks
 * land with STORAGE-5 (handlers) and STORAGE-7 (workers) respectively.
 */
export const readyRoute = new Hono();

readyRoute.get('/', (c) =>
  c.json({
    ok: true,
    deps: {},
  }),
);
