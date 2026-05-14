/**
 * STORAGE-6 — create signed download URL.
 *
 * Action key: `platform.storage.objects.read` (with `operation: 'download_url'`).
 *
 * Flow:
 *   1. Validate payload.
 *   2. Lookup object scoped to workspace.
 *      - Not found / wrong workspace / deleted -> `ValidationError("Object not found")`.
 *      - Not in a deliverable state (`pending_upload`) -> 400 with a
 *        non-leaky message.
 *      - Visibility `public` is still served via a signed URL in MVP — plan
 *        §STORAGE-9: "public visibility does not mean public delivery
 *        until scan/validation passes". We treat `public` the same as
 *        `private` from the URL-minting perspective.
 *   3. Resolve the provider that holds the original by `providerId` (NOT
 *      the workspace default — see §STORAGE-6 acceptance criteria).
 *      `ForbiddenError` if the provider is gone.
 *   4. Sign the URL.
 *   5. Return `{ objectId, url, expiresAt }` and nothing else.
 *
 * Plan §STORAGE-9: "Signed read URLs are short-lived and only created
 * after permission checks." Workspace ownership IS the permission check
 * here — the gateway has already enforced the `platform.storage.objects.read`
 * action key (STORAGE-3).
 */
import { ForbiddenError, ValidationError } from '../../errors';
import type { ActionContext } from '../../types';
import type { CreateDownloadUrlResponse } from './responses';
import { DEFAULT_DOWNLOAD_URL_TTL_SECONDS, createDownloadUrlPayloadSchema } from './schemas';
import type { ObjectsHandlerDependencies } from './types';

/**
 * Object states that ARE eligible for a signed download URL.
 *
 * `pending_upload` is explicitly excluded: the original is not yet on the
 * provider, so a signed GET would return 404 / NoSuchKey and confuse the
 * caller.
 *
 * `failed` is included so a caller can still inspect what landed (the
 * processing pipeline may have failed AFTER the original landed on the
 * provider — the original object is preserved per the product principles
 * in plan §4).
 */
const DELIVERABLE_STATUSES = new Set(['uploaded', 'processing', 'ready', 'failed']);

export function createDownloadUrlHandler(deps: ObjectsHandlerDependencies) {
  const defaultTtl = deps.defaultDownloadTtlSeconds ?? DEFAULT_DOWNLOAD_URL_TTL_SECONDS;

  return async (payload: unknown, ctx: ActionContext): Promise<CreateDownloadUrlResponse> => {
    const parseResult = createDownloadUrlPayloadSchema.safeParse(payload);
    if (!parseResult.success) {
      throw new ValidationError(parseResult.error.issues[0]?.message ?? 'Invalid payload');
    }
    const input = parseResult.data;

    const object = await deps.objects.findByIdForWorkspace({
      objectId: input.objectId,
      workspaceId: ctx.workspaceId,
    });
    if (!object || object.status === 'deleted') {
      throw new ValidationError('Object not found');
    }
    if (!DELIVERABLE_STATUSES.has(object.status)) {
      throw new ValidationError('Object is not yet available for download');
    }

    const provider = await deps.providers.resolveByProviderIdForWorkspace({
      workspaceId: ctx.workspaceId,
      providerId: object.providerId,
    });
    if (!provider) {
      // The provider record is gone (or moved to a different workspace).
      // Operationally a workspace-admin state — surface as 403, redacted.
      throw new ForbiddenError(
        'Storage provider for this object is no longer available. Contact a workspace admin.',
      );
    }

    const ttl = input.expiresInSeconds ?? defaultTtl;
    const signed = await provider.adapter.createDownloadUrl({
      objectKey: object.providerObjectKey,
      expiresInSeconds: ttl,
      downloadFilename: input.downloadFilename,
    });

    return {
      objectId: object.id,
      url: signed.url,
      expiresAt: signed.expiresAt.toISOString(),
    };
  };
}
