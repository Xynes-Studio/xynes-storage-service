import { buildApp } from './app';
import { buildComposition } from './composition';
import { loadConfig } from './infra/config';
import { startLifecycle, resolveLifecycleConfig } from './infra/lifecycle';
import { Quiescence, startPrivateControl } from './infra/quiescence';
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

// STORAGE-FU-6: wire the worker + abandoned-upload-cleanup polling
// loops into the process lifecycle. Reads optional env overrides
// (`STORAGE_WORKER_POLL_INTERVAL_MS`, `STORAGE_CLEANUP_INTERVAL_MS`,
// `STORAGE_SHUTDOWN_TIMEOUT_MS`) and registers `SIGTERM` / `SIGINT`
// handlers that drain in-flight work, tear down the composition
// (closing the owned DB pool), and exit the process gracefully.
//
// Worker concurrency caps (`STORAGE_WORKER_MAX_CONCURRENT`,
// `STORAGE_WORKER_MAX_PER_WORKSPACE`) are consumed inside
// `buildComposition` when constructing the `ProcessingWorker` so they
// take effect before `start()` is called here.
// Hosted admission/drain control is mandatory; unconfigured local dev keeps
// its existing signal behavior. Tokens/sockets are fixed protected assets.
const enabled = process.env.STORAGE_QUIESCENCE_ENABLED === '1';
if (process.env.NODE_ENV === 'production' && !enabled) {
  throw new Error('Storage hosted control required');
}
const intervals = resolveLifecycleConfig();
const quiescence = enabled
  ? new Quiescence({
      worker: composition.worker,
      cleanup: composition.cleanup,
      workerIntervalMs: intervals.workerPollIntervalMs,
      cleanupIntervalMs: intervals.cleanupPollIntervalMs,
    })
  : undefined;
const control = quiescence ? await startPrivateControl(quiescence) : undefined;
const lifecycle = startLifecycle(composition, { quiescence, closeControl: control?.close });

const app = buildApp(config);

logger.info('Storage service starting', {
  port: config.port,
  workerPollIntervalMs: lifecycle.config.workerPollIntervalMs,
  cleanupPollIntervalMs: lifecycle.config.cleanupPollIntervalMs,
});

export { composition, lifecycle };
export default {
  port: config.port,
  fetch: quiescence ? quiescence.wrap((request) => app.fetch(request)) : app.fetch,
};
