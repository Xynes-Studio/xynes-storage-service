/**
 * STORAGE-FU-5-FU-G — Error envelope shape.
 *
 * The shim NEVER echoes raw soffice stderr, library version strings,
 * or per-request paths. Every error response is a closed-set
 * `{ code, message }` envelope that FU-C's
 * `LibreOfficeDocumentProcessor` will translate into the appropriate
 * RunnerInputError / RunnerExecutionError without inspecting the body
 * (it relies on the status code).
 *
 * Closed-set codes that may cross the wire. Adding a new code here
 * requires updating the static validator + plan §12.5 acceptance
 * criteria.
 */
export const SHIM_ERROR_CODES = {
  INVALID_JSON: 'INVALID_JSON',
  MISSING_FIELD: 'MISSING_FIELD',
  UNSUPPORTED_FORMAT: 'UNSUPPORTED_FORMAT',
  OVER_MAX_BYTES: 'OVER_MAX_BYTES',
  INVALID_BASE64: 'INVALID_BASE64',
  CONVERT_FAILED: 'CONVERT_FAILED',
  TIMEOUT: 'TIMEOUT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ShimErrorCode = (typeof SHIM_ERROR_CODES)[keyof typeof SHIM_ERROR_CODES];

/**
 * Envelope returned by every non-2xx response. The optional `message`
 * is a fixed string per code — NEVER an interpolated stderr blob.
 */
export interface ShimErrorBody {
  readonly code: ShimErrorCode;
  readonly message: string;
}

/** Status code for each closed-set error. */
export const SHIM_ERROR_STATUS: Record<ShimErrorCode, number> = {
  INVALID_JSON: 400,
  MISSING_FIELD: 400,
  UNSUPPORTED_FORMAT: 415,
  OVER_MAX_BYTES: 413,
  INVALID_BASE64: 400,
  CONVERT_FAILED: 500,
  TIMEOUT: 504,
  INTERNAL_ERROR: 500,
};

/** Fixed, redaction-safe messages. NO interpolation. */
export const SHIM_ERROR_MESSAGE: Record<ShimErrorCode, string> = {
  INVALID_JSON: 'Request body is not valid JSON.',
  MISSING_FIELD: 'Request body is missing a required field.',
  UNSUPPORTED_FORMAT: 'Source content type is not supported.',
  OVER_MAX_BYTES: 'Request payload exceeds the maximum allowed size.',
  INVALID_BASE64: 'Request bytes are not valid base64.',
  CONVERT_FAILED: 'Document conversion failed.',
  TIMEOUT: 'Document conversion timed out.',
  INTERNAL_ERROR: 'Internal sidecar error.',
};

/** Build the canonical response body for a given code. */
export function buildErrorBody(code: ShimErrorCode): ShimErrorBody {
  return { code, message: SHIM_ERROR_MESSAGE[code] };
}
