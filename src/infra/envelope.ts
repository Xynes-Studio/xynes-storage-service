/**
 * Standard API Response Envelope.
 *
 * Mirrors the contract used by xynes-accounts-service and xynes-cms-core
 * so a single gateway envelope-parser handles every backend service.
 */
import type { ZodError, ZodIssue } from 'zod';

export interface ApiMeta {
  requestId: string;
}

export interface ApiSuccess<T> {
  ok: true;
  data: T;
  meta?: ApiMeta;
}

export interface ApiErrorDetails {
  issues?: Array<{ path: (string | number)[]; message: string; code?: string }>;
  [key: string]: unknown;
}

export interface ApiErrorPayload {
  code: string;
  message: string;
  details?: ApiErrorDetails;
}

export interface ApiError {
  ok: false;
  error: ApiErrorPayload;
  meta?: ApiMeta;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

export function createSuccessResponse<T>(data: T, requestId?: string): ApiSuccess<T> {
  const response: ApiSuccess<T> = { ok: true, data };
  if (requestId) response.meta = { requestId };
  return response;
}

export function createErrorResponse(
  code: string,
  message: string,
  requestId?: string,
  details?: ApiErrorDetails,
): ApiError {
  const response: ApiError = { ok: false, error: { code, message } };
  if (details) response.error.details = details;
  if (requestId) response.meta = { requestId };
  return response;
}

export function formatZodError(error: ZodError): ApiErrorDetails {
  return {
    issues: error.issues.map((issue: ZodIssue) => ({
      path: issue.path as (string | number)[],
      message: issue.message,
      code: issue.code,
    })),
  };
}

export function createValidationErrorResponse(
  error: ZodError,
  requestId?: string,
  message = 'Payload validation failed',
): ApiError {
  return createErrorResponse('VALIDATION_ERROR', message, requestId, formatZodError(error));
}
