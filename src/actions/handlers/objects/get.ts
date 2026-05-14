/**
 * STORAGE-6 — get one object with variants + processing jobs.
 *
 * Action key: `platform.storage.objects.read` (with `operation: 'get'`).
 *
 * Flow:
 *   1. Validate payload.
 *   2. Lookup object scoped to workspace.
 *      - Not found / wrong workspace -> `ValidationError("Object not found")`
 *        (same envelope so a hostile caller cannot probe other workspaces).
 *      - `status = 'deleted'` -> `ValidationError("Object not found")` so
 *        soft-deleted objects are indistinguishable from never-existed ones.
 *   3. Lookup variants + processing jobs in parallel.
 *   4. Return the documented DTO.
 */
import { ValidationError } from '../../errors';
import type { ActionContext } from '../../types';
import { toGetObjectResponse, type GetObjectResponse } from './responses';
import { getObjectPayloadSchema } from './schemas';
import type { ObjectsHandlerDependencies } from './types';

export function createGetObjectHandler(deps: ObjectsHandlerDependencies) {
  return async (payload: unknown, ctx: ActionContext): Promise<GetObjectResponse> => {
    const parseResult = getObjectPayloadSchema.safeParse(payload);
    if (!parseResult.success) {
      throw new ValidationError(parseResult.error.issues[0]?.message ?? 'Invalid payload');
    }
    const { objectId } = parseResult.data;

    const object = await deps.objects.findByIdForWorkspace({
      objectId,
      workspaceId: ctx.workspaceId,
    });
    if (!object || object.status === 'deleted') {
      throw new ValidationError('Object not found');
    }

    const [variants, jobs] = await Promise.all([
      deps.variants.listForObject({ objectId: object.id, workspaceId: ctx.workspaceId }),
      deps.jobs.listForObject({ objectId: object.id, workspaceId: ctx.workspaceId }),
    ]);

    return toGetObjectResponse(object, variants, jobs);
  };
}
