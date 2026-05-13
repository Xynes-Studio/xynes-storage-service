import { UnknownActionError } from './errors';
import { getHandler } from './registry';
import type { ActionContext, StorageActionKey } from './types';

/**
 * Dispatch an action by key. Unknown keys throw `UnknownActionError` which
 * the error handler maps to `400 UNKNOWN_ACTION`.
 */
export async function executeStorageAction(
  actionKey: string,
  payload: unknown,
  ctx: ActionContext,
): Promise<unknown> {
  const handler = getHandler(actionKey as StorageActionKey);
  if (!handler) {
    throw new UnknownActionError(actionKey);
  }
  return handler(payload, ctx);
}
