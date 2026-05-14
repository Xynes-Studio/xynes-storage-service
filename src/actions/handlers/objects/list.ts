/**
 * STORAGE-6 — list workspace storage objects (paginated).
 *
 * Action key: `platform.storage.objects.read` (with `operation: 'list'`).
 *
 * Flow:
 *   1. Validate payload (strict schema).
 *   2. Decode + validate the opaque cursor if present.
 *   3. Call the repo with workspace scope, filters, limit, and cursor.
 *   4. Map records to public DTOs, filtering out any defensive `deleted`
 *      rows that slipped through.
 *   5. Return `{ items, nextCursor }`.
 *
 * Workspace ownership is enforced ENTIRELY at the repo layer. The handler
 * never crosses workspace boundaries — there is no `workspaceId` parameter
 * on the payload; it's read from `ctx.workspaceId`.
 */
import { ValidationError } from '../../errors';
import type { ActionContext } from '../../types';
import { decodeListCursor, InvalidCursorError } from './cursor';
import { toListObjectsResponse, type ListObjectsResponse } from './responses';
import { DEFAULT_LIST_LIMIT, listObjectsPayloadSchema, type ListObjectsFilters } from './schemas';
import type { ListObjectsRepoFilters, ObjectsHandlerDependencies } from './types';

function mapFilters(filters: ListObjectsFilters | undefined): ListObjectsRepoFilters {
  if (!filters) return {};
  return {
    purpose: filters.purpose,
    status: filters.status,
    contentTypeFamily: filters.contentTypeFamily,
    createdBy: filters.createdBy,
    createdAfter: filters.createdAfter ? new Date(filters.createdAfter) : undefined,
    createdBefore: filters.createdBefore ? new Date(filters.createdBefore) : undefined,
  };
}

export function createListObjectsHandler(deps: ObjectsHandlerDependencies) {
  const defaultLimit = deps.defaultListLimit ?? DEFAULT_LIST_LIMIT;

  return async (payload: unknown, ctx: ActionContext): Promise<ListObjectsResponse> => {
    const parseResult = listObjectsPayloadSchema.safeParse(payload);
    if (!parseResult.success) {
      throw new ValidationError(parseResult.error.issues[0]?.message ?? 'Invalid payload');
    }
    const input = parseResult.data;

    // Defensive: refuse contradictory date filters BEFORE we hit the repo.
    if (input.filters?.createdAfter && input.filters?.createdBefore) {
      if (input.filters.createdAfter > input.filters.createdBefore) {
        throw new ValidationError('`createdAfter` must be <= `createdBefore`');
      }
    }

    let decodedCursor: string | null;
    try {
      const decoded = decodeListCursor(input.cursor);
      decodedCursor = decoded ? (input.cursor ?? null) : null;
    } catch (err) {
      if (err instanceof InvalidCursorError) {
        throw new ValidationError(err.message);
      }
      throw err;
    }

    const result = await deps.objects.listForWorkspace({
      workspaceId: ctx.workspaceId,
      filters: mapFilters(input.filters),
      limit: input.limit ?? defaultLimit,
      cursor: decodedCursor,
    });

    return toListObjectsResponse(result.items, result.nextCursor);
  };
}
