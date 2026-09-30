import { randomUUID } from 'node:crypto';
import type { StorageObjectRecord } from './types';

/** This namespace is never targeted by client upload capabilities. */
export function finalizedSourcePrefix(
  object: Pick<StorageObjectRecord, 'workspaceId' | 'id'>,
): string {
  return `workspaces/${object.workspaceId}/finalized/v1/${object.id}/`;
}

export function createFinalizedSourceKey(object: StorageObjectRecord): string {
  return finalizedSourcePrefix(object) + randomUUID();
}

export function isFinalizedSource(
  object: Pick<StorageObjectRecord, 'workspaceId' | 'id' | 'providerObjectKey'>,
): boolean {
  const prefix = finalizedSourcePrefix(object);
  return (
    object.providerObjectKey.startsWith(prefix) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      object.providerObjectKey.slice(prefix.length),
    )
  );
}
