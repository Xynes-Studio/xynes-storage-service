import { buildApp } from './app';
import { loadConfig } from './infra/config';
import { logger } from './infra/logger';

const config = loadConfig();
const app = buildApp(config);

logger.info('Storage service starting', { port: config.port });

export default {
  port: config.port,
  fetch: app.fetch,
};
