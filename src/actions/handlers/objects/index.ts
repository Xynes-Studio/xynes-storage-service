/**
 * STORAGE-6 — action-key dispatchers for object metadata, signed reads,
 * delete, and usage.
 *
 * Three action keys (per STORAGE-3 route seeds + plan §7):
 *   - `platform.storage.objects.read`   → ops: `list`, `get`, `download_url`
 *   - `platform.storage.objects.delete` → op:  `delete`
 *   - `platform.storage.usage.read`     → op:  `usage`
 *
 * Each dispatcher registers ONE handler against its action key and
 * branches on the payload-level `operation` discriminator — same posture
 * as the STORAGE-5 upload action handler.
 *
 * Each operation handler is exported separately so tests can drive the
 * happy paths + error paths directly without going through a dispatcher.
 */
import { ValidationError } from '../../errors';
import { registerHandler } from '../../registry';
import type { ActionContext } from '../../types';
import { createDeleteObjectHandler } from './delete';
import { createDownloadUrlHandler } from './download-url';
import { createGetObjectHandler } from './get';
import { createListObjectsHandler } from './list';
import type { ObjectsHandlerDependencies } from './types';
import { createUsageReadHandler } from './usage';

export const STORAGE_OBJECTS_READ_ACTION_KEY = 'platform.storage.objects.read' as const;
export const STORAGE_OBJECTS_DELETE_ACTION_KEY = 'platform.storage.objects.delete' as const;
export const STORAGE_USAGE_READ_ACTION_KEY = 'platform.storage.usage.read' as const;

function hasOperation(payload: unknown): payload is { operation: unknown } {
  return typeof payload === 'object' && payload !== null && 'operation' in payload;
}

export function buildObjectsReadActionHandler(deps: ObjectsHandlerDependencies) {
  const list = createListObjectsHandler(deps);
  const get = createGetObjectHandler(deps);
  const download = createDownloadUrlHandler(deps);

  return async (payload: unknown, ctx: ActionContext): Promise<unknown> => {
    if (!hasOperation(payload)) {
      throw new ValidationError(
        'Payload `operation` is required (one of: list, get, download_url)',
      );
    }
    const op = (payload as { operation: unknown }).operation;
    switch (op) {
      case 'list':
        return list(payload, ctx);
      case 'get':
        return get(payload, ctx);
      case 'download_url':
        return download(payload, ctx);
      default:
        throw new ValidationError('Payload `operation` must be one of: list, get, download_url');
    }
  };
}

export function buildObjectsDeleteActionHandler(deps: ObjectsHandlerDependencies) {
  const del = createDeleteObjectHandler(deps);

  return async (payload: unknown, ctx: ActionContext): Promise<unknown> => {
    if (!hasOperation(payload)) {
      throw new ValidationError('Payload `operation` is required (must be: delete)');
    }
    const op = (payload as { operation: unknown }).operation;
    if (op !== 'delete') {
      throw new ValidationError('Payload `operation` must be: delete');
    }
    return del(payload, ctx);
  };
}

export function buildUsageReadActionHandler(deps: ObjectsHandlerDependencies) {
  const usage = createUsageReadHandler(deps);

  return async (payload: unknown, ctx: ActionContext): Promise<unknown> => {
    if (!hasOperation(payload)) {
      throw new ValidationError('Payload `operation` is required (must be: usage)');
    }
    const op = (payload as { operation: unknown }).operation;
    if (op !== 'usage') {
      throw new ValidationError('Payload `operation` must be: usage');
    }
    return usage(payload, ctx);
  };
}

export function registerObjectActionHandlers(deps: ObjectsHandlerDependencies): void {
  registerHandler(STORAGE_OBJECTS_READ_ACTION_KEY, buildObjectsReadActionHandler(deps));
  registerHandler(STORAGE_OBJECTS_DELETE_ACTION_KEY, buildObjectsDeleteActionHandler(deps));
  registerHandler(STORAGE_USAGE_READ_ACTION_KEY, buildUsageReadActionHandler(deps));
}

export {
  createDeleteObjectHandler,
  createDownloadUrlHandler,
  createGetObjectHandler,
  createListObjectsHandler,
  createUsageReadHandler,
};
export type { ObjectsHandlerDependencies };
