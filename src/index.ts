import { buildApp } from './app';
import { buildComposition } from './composition';
import { loadConfig } from './infra/config';
import { logger } from './infra/logger';

const config = loadConfig();

// STORAGE-FU-4: build composition root BEFORE the HTTP server accepts
// traffic. `buildComposition` registers every action handler shipped by
// STORAGE-5/6/7 on the shared registry and emits the structured
// `storage.service.ready` log entry. The function throws when
// `DATABASE_URL` is missing/blank (matches the gateway's startup
// posture) — we deliberately let the error propagate so the process
// crashes loudly instead of silently serving `UNKNOWN_ACTION` envelopes.
const composition = buildComposition();

const app = buildApp(config);

logger.info('Storage service starting', { port: config.port });

export { composition };
export default {
  port: config.port,
  fetch: app.fetch,
};
