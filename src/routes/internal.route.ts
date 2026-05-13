/**
 * Internal action route — POST /internal/storage-actions.
 *
 * Parses the gateway-emitted envelope + actor surface and dispatches to
 * `executeStorageAction`. Handlers themselves land in STORAGE-5..STORAGE-7.
 *
 * Actor contract (PFU-1 / CMS-API-KEY-ACTOR-1 byte-for-byte):
 *   - `X-XS-Actor-Type`: 'user' | 'api_key' (defaults to 'user').
 *   - `X-XS-User-Id`: required for user actors (UUID).
 *   - `X-XS-API-Key-Id`: required for api_key actors (UUID).
 *   - `X-XS-API-Key-Prefix`: required for api_key actors (8 hex chars).
 *   - `X-Workspace-Id`: required for ALL storage actions (no public surface).
 *
 * Malformed headers are rejected with `400 INVALID_HEADER` BEFORE any
 * handler dispatch runs.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { ServiceConfig } from '../infra/config';
import {
  createErrorResponse,
  createSuccessResponse,
  createValidationErrorResponse,
} from '../infra/envelope';
import { logger } from '../infra/logger';
import { generateRequestId } from '../infra/request-id';
import { requireInternalServiceAuth } from '../middleware/internal-service-auth';
import { executeStorageAction } from '../actions/execute';
import type { ActionActor, ActionContext } from '../actions/types';
import {
  ForbiddenActorKindError,
  ForbiddenError,
  UnauthorizedError,
  UnknownActionError,
  ValidationError,
} from '../actions/errors';

const actionRequestSchema = z
  .object({
    actionKey: z.string().min(1),
    payload: z.unknown(),
  })
  .strict();

const uuidHeader = z.string().uuid();
const apiKeyPrefixHeader = z.string().regex(/^[a-f0-9]{8}$/, 'must be 8 hex chars');
const ACTOR_KINDS = new Set(['user', 'api_key']);

export function buildInternalRoute(config: ServiceConfig): Hono {
  const route = new Hono();
  route.use('*', requireInternalServiceAuth(config));

  route.post('/storage-actions', async (c) => {
    const requestId = (c.get('requestId') as string | undefined) ?? generateRequestId();
    c.set('requestId', requestId);

    // Body parsing with a small max size — object data goes direct to provider,
    // so the action envelope itself is small.
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(createErrorResponse('INVALID_BODY', 'Body must be valid JSON', requestId), 400);
    }

    const parsed = actionRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        createValidationErrorResponse(parsed.error, requestId, 'Invalid request body'),
        400,
      );
    }
    const { actionKey, payload } = parsed.data;

    // Actor resolution.
    const rawActorType = c.req.header('X-XS-Actor-Type');
    if (rawActorType && !ACTOR_KINDS.has(rawActorType)) {
      return c.json(
        createErrorResponse(
          'INVALID_HEADER',
          'X-XS-Actor-Type must be one of: user, api_key',
          requestId,
        ),
        400,
      );
    }
    const actorType: 'user' | 'api_key' = rawActorType === 'api_key' ? 'api_key' : 'user';

    let actor: ActionActor;
    if (actorType === 'api_key') {
      const rawApiKeyId = c.req.header('X-XS-API-Key-Id');
      if (!rawApiKeyId) {
        return c.json(
          createErrorResponse(
            'INVALID_HEADER',
            'X-XS-API-Key-Id header is required for api_key actor',
            requestId,
          ),
          400,
        );
      }
      const apiKeyIdResult = uuidHeader.safeParse(rawApiKeyId);
      if (!apiKeyIdResult.success) {
        return c.json(
          createErrorResponse('INVALID_HEADER', 'X-XS-API-Key-Id must be a UUID', requestId),
          400,
        );
      }
      const rawPrefix = c.req.header('X-XS-API-Key-Prefix');
      if (!rawPrefix) {
        return c.json(
          createErrorResponse(
            'INVALID_HEADER',
            'X-XS-API-Key-Prefix header is required for api_key actor',
            requestId,
          ),
          400,
        );
      }
      const prefixResult = apiKeyPrefixHeader.safeParse(rawPrefix);
      if (!prefixResult.success) {
        return c.json(
          createErrorResponse(
            'INVALID_HEADER',
            'X-XS-API-Key-Prefix must be 8 lowercase hex chars',
            requestId,
          ),
          400,
        );
      }
      actor = {
        kind: 'api_key',
        apiKeyId: apiKeyIdResult.data,
        keyPrefix: prefixResult.data,
      };
    } else {
      const rawUserId = c.req.header('X-XS-User-Id');
      if (!rawUserId) {
        return c.json(
          createErrorResponse('UNAUTHORIZED', 'X-XS-User-Id header is required', requestId),
          401,
        );
      }
      const userIdResult = uuidHeader.safeParse(rawUserId);
      if (!userIdResult.success) {
        return c.json(
          createErrorResponse('INVALID_HEADER', 'X-XS-User-Id must be a UUID', requestId),
          400,
        );
      }
      actor = { kind: 'user', userId: userIdResult.data };
    }

    // Workspace id — required for ALL storage actions.
    const rawWorkspaceId = c.req.header('X-Workspace-Id');
    if (!rawWorkspaceId) {
      return c.json(
        createErrorResponse('MISSING_HEADER', 'X-Workspace-Id header is required', requestId),
        400,
      );
    }
    const workspaceIdResult = uuidHeader.safeParse(rawWorkspaceId);
    if (!workspaceIdResult.success) {
      return c.json(
        createErrorResponse('INVALID_HEADER', 'X-Workspace-Id must be a UUID', requestId),
        400,
      );
    }

    const ctx: ActionContext = {
      workspaceId: workspaceIdResult.data,
      requestId,
      actor,
      userId: actor.kind === 'user' ? actor.userId : undefined,
    };

    logger.info('Internal storage action', {
      actionKey,
      workspaceId: ctx.workspaceId,
      actorType: actor.kind,
      apiKeyId: actor.kind === 'api_key' ? actor.apiKeyId : undefined,
      requestId,
    });

    try {
      const data = await executeStorageAction(actionKey, payload, ctx);
      return c.json(createSuccessResponse(data, requestId), 200);
    } catch (err) {
      if (err instanceof UnknownActionError) {
        return c.json(createErrorResponse(err.code, err.message, requestId), 400);
      }
      if (err instanceof ValidationError) {
        return c.json(createErrorResponse(err.code, err.message, requestId), 400);
      }
      if (err instanceof UnauthorizedError) {
        return c.json(createErrorResponse(err.code, err.message, requestId), 401);
      }
      if (err instanceof ForbiddenError || err instanceof ForbiddenActorKindError) {
        return c.json(createErrorResponse(err.code, err.message, requestId), 403);
      }
      // Re-throw — `onError` will map to a redacted INTERNAL_ERROR response.
      throw err;
    }
  });

  return route;
}
