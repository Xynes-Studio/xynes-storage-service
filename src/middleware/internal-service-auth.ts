/**
 * Internal service authentication middleware.
 *
 * STORAGE-4 ships a deliberately minimal token check that mirrors the
 * legacy path from `xynes-accounts-service/src/middleware/internal-service-auth.ts`.
 * STORAGE-3 will upgrade this to the shared JWT-based scheme once
 * `xynes-gateway` is wired to forward signed audience tokens.
 *
 * Security invariants:
 *   - Token values are never logged.
 *   - Comparison is timing-safe.
 *   - Missing config in `jwt` mode is a 500 (fail-closed), not a silent allow.
 */
import type { Context, Next } from 'hono';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createErrorResponse } from '../infra/envelope';
import { logger } from '../infra/logger';
import { generateRequestId } from '../infra/request-id';
import type { ServiceConfig } from '../infra/config';

function tokensMatch(provided: string, expected: string): boolean {
  const key = Buffer.from(expected);
  const providedDigest = createHmac('sha256', key).update(provided).digest();
  const expectedDigest = createHmac('sha256', key).update(expected).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

export function requireInternalServiceAuth(config: ServiceConfig) {
  return async (c: Context, next: Next) => {
    const requestId = c.get('requestId') || generateRequestId();
    c.set('requestId', requestId);

    const provided = c.req.header('X-Internal-Service-Token');
    if (!provided) {
      logger.warn('Internal auth rejected: missing token header', {
        requestId,
        path: c.req.path,
        method: c.req.method,
      });
      return c.json(
        createErrorResponse('UNAUTHORIZED', 'Missing internal auth token', requestId),
        401,
      );
    }

    const expected = config.internalServiceToken;
    if (!expected) {
      logger.error('Internal auth misconfigured: no token set', {
        requestId,
        path: c.req.path,
        method: c.req.method,
      });
      return c.json(
        createErrorResponse('INTERNAL_ERROR', 'Internal auth misconfigured', requestId),
        500,
      );
    }

    if (!tokensMatch(provided, expected)) {
      logger.warn('Internal auth rejected: invalid token', {
        requestId,
        path: c.req.path,
        method: c.req.method,
      });
      return c.json(
        createErrorResponse('FORBIDDEN', 'Invalid internal auth token', requestId),
        403,
      );
    }

    await next();
  };
}
