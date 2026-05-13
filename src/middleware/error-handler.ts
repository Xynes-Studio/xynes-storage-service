/**
 * Centralised error handler. Maps thrown errors into the canonical envelope.
 *
 * STORAGE-5+ handlers may throw `ProviderAdapterError` (see
 * `src/infra/providers/errors.ts`) — that family is mapped here so adapter
 * failures surface as `BAD_GATEWAY` / `INTERNAL_ERROR` with redacted details.
 */
import type { Context, ErrorHandler } from 'hono';
import { ZodError } from 'zod';
import {
  createErrorResponse,
  createValidationErrorResponse,
  type ApiError,
} from '../infra/envelope';
import { logger } from '../infra/logger';
import { ProviderAdapterError } from '../infra/providers/errors';

export const errorHandler: ErrorHandler = (err: Error, c: Context) => {
  const requestId = c.get('requestId') as string | undefined;

  if (err instanceof ZodError) {
    return c.json<ApiError>(createValidationErrorResponse(err, requestId), 400);
  }

  if (err instanceof ProviderAdapterError) {
    // Provider adapter errors are pre-redacted by design.
    logger.warn('Provider adapter error', {
      requestId,
      code: err.code,
      // `err.message` is the redacted human-safe message; raw provider error
      // bodies are not attached to the ProviderAdapterError class.
      message: err.message,
    });
    const status = err.statusHint ?? 502;
    return c.json<ApiError>(createErrorResponse(err.code, err.message, requestId), status as 502);
  }

  logger.error('Unhandled error', {
    requestId,
    name: err.name,
    // Do NOT include err.message verbatim in logs — it may carry caller payload
    // fragments. We log the name only and rely on the request id to correlate.
  });

  return c.json<ApiError>(
    createErrorResponse('INTERNAL_ERROR', 'Internal server error', requestId),
    500,
  );
};
