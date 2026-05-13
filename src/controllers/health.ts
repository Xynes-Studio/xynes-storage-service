import { Hono } from 'hono';

/**
 * Liveness probe. Returns 200 regardless of downstream readiness — this is
 * the signal the orchestrator uses to decide whether the container is
 * still alive.
 */
export const healthRoute = new Hono();

healthRoute.get('/', (c) =>
  c.json({
    ok: true,
    service: 'storage-service',
  }),
);
