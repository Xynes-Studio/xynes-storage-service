import type { Context, Next } from 'hono';
import { generateRequestId } from '../infra/request-id';

/**
 * Per-request `X-Request-Id` propagation.
 *
 * Honours an upstream id when present (gateway will always set one), otherwise
 * generates a new id. The id is stored in the Hono context as `requestId` and
 * echoed in the response header.
 */
export function requestIdMiddleware() {
  return async (c: Context, next: Next) => {
    const forwarded = c.req.header('X-Request-Id');
    const requestId = forwarded && forwarded.trim().length > 0 ? forwarded : generateRequestId();
    c.set('requestId', requestId);
    c.header('X-Request-Id', requestId);
    await next();
  };
}
