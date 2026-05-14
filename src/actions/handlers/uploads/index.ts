/**
 * Upload lifecycle dispatcher.
 *
 * The gateway routes for create / complete / abort all funnel here with the
 * single action key `platform.storage.objects.upload` (per STORAGE-3 route
 * seeds). We register ONE handler against that action key and branch on the
 * payload-level `operation` discriminator.
 *
 * Each operation handler is exported separately so tests can exercise them
 * directly without going through the dispatcher.
 */
import { ValidationError } from '../../errors';
import { registerHandler } from '../../registry';
import type { ActionContext } from '../../types';
import { createCreateUploadHandler } from './create';
import { createCompleteUploadHandler } from './complete';
import { createAbortUploadHandler } from './abort';
import type { UploadHandlerDependencies } from './types';

export const STORAGE_UPLOAD_ACTION_KEY = 'platform.storage.objects.upload' as const;

export function buildUploadActionHandler(deps: UploadHandlerDependencies) {
  const create = createCreateUploadHandler(deps);
  const complete = createCompleteUploadHandler(deps);
  const abort = createAbortUploadHandler(deps);

  return async (payload: unknown, ctx: ActionContext): Promise<unknown> => {
    if (
      typeof payload !== 'object' ||
      payload === null ||
      !('operation' in (payload as Record<string, unknown>))
    ) {
      throw new ValidationError(
        'Payload `operation` is required (one of: create, complete, abort)',
      );
    }
    const op = (payload as { operation: unknown }).operation;
    switch (op) {
      case 'create':
        return create(payload, ctx);
      case 'complete':
        return complete(payload, ctx);
      case 'abort':
        return abort(payload, ctx);
      default:
        throw new ValidationError('Payload `operation` must be one of: create, complete, abort');
    }
  };
}

export function registerUploadActionHandlers(deps: UploadHandlerDependencies): void {
  registerHandler(STORAGE_UPLOAD_ACTION_KEY, buildUploadActionHandler(deps));
}

export { createCreateUploadHandler, createCompleteUploadHandler, createAbortUploadHandler };
export type { UploadHandlerDependencies };
