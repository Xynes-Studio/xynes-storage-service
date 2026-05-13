/**
 * Action registry. STORAGE-4 ships with an empty registry — the handlers
 * are registered by STORAGE-5..STORAGE-7. Until then any incoming action
 * key surfaces as `UnknownActionError` (400 UNKNOWN_ACTION) from `execute()`.
 */
import type { StorageActionHandler, StorageActionKey } from './types';

const handlers = new Map<StorageActionKey, StorageActionHandler>();

export function registerHandler(key: StorageActionKey, handler: StorageActionHandler): void {
  handlers.set(key, handler);
}

export function getHandler(key: StorageActionKey): StorageActionHandler | undefined {
  return handlers.get(key);
}

/**
 * Test-only: reset the registry. Production code never calls this.
 */
export function __resetRegistry(): void {
  handlers.clear();
}
