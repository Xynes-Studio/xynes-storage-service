/**
 * Hono app wiring. Exported as a builder so tests can construct an app
 * against a custom config (e.g., overridden internal service token) without
 * polluting process.env.
 */
import { Hono } from 'hono';
import type { ServiceConfig } from './infra/config';
import { errorHandler } from './middleware/error-handler';
import { requestIdMiddleware } from './middleware/request-id';
import { healthRoute } from './controllers/health';
import { readyRoute } from './controllers/ready';
import { buildInternalRoute } from './routes/internal.route';

export function buildApp(config: ServiceConfig): Hono {
  const app = new Hono();

  app.use('*', requestIdMiddleware());

  app.route('/health', healthRoute);
  app.route('/ready', readyRoute);
  app.route('/internal', buildInternalRoute(config));

  app.onError(errorHandler);

  return app;
}
