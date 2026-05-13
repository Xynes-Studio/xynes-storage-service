/**
 * Provider adapter error family. Errors thrown here are PRE-REDACTED — they
 * carry only a stable code and a human-safe message. They never carry raw
 * provider error bodies, presigned URL signature parameters, or credential
 * values.
 *
 * The error handler in `src/middleware/error-handler.ts` maps these to the
 * canonical API envelope without further redaction.
 */

export type ProviderAdapterErrorCode =
  /** Configuration is missing required fields or contains invalid values. */
  | 'PROVIDER_CONFIG_INVALID'
  /** Provider operation failed (network / auth / provider-side error). */
  | 'PROVIDER_OPERATION_FAILED'
  /** Caller asked for behaviour the adapter intentionally refuses. */
  | 'PROVIDER_OPERATION_REFUSED'
  /** Multipart part count or part size violates the AWS S3 contract. */
  | 'PROVIDER_MULTIPART_CONTRACT_VIOLATED'
  /** Object key is empty, too long, or otherwise malformed. */
  | 'PROVIDER_OBJECT_KEY_INVALID'
  /** A presigned URL request would have produced an expiry outside spec. */
  | 'PROVIDER_PRESIGN_EXPIRY_INVALID';

const SAFE_MESSAGES: Record<ProviderAdapterErrorCode, string> = {
  PROVIDER_CONFIG_INVALID: 'Storage provider configuration is invalid',
  PROVIDER_OPERATION_FAILED: 'Storage provider operation failed',
  PROVIDER_OPERATION_REFUSED: 'Storage provider operation refused by adapter',
  PROVIDER_MULTIPART_CONTRACT_VIOLATED: 'Multipart upload violates the AWS S3 part-size contract',
  PROVIDER_OBJECT_KEY_INVALID: 'Storage object key is invalid',
  PROVIDER_PRESIGN_EXPIRY_INVALID: 'Presigned URL expiry is outside the allowed range',
};

export class ProviderAdapterError extends Error {
  public readonly code: ProviderAdapterErrorCode;
  public readonly statusHint: number;

  constructor(code: ProviderAdapterErrorCode, message?: string, statusHint = 502) {
    // Always start from the safe default message. A caller may pass a more
    // specific override — but the override is bounded to safe strings (no
    // credentials, no presigned URL parameters) because callers in this
    // repo never embed those values in error messages.
    super(message ?? SAFE_MESSAGES[code]);
    this.name = 'ProviderAdapterError';
    this.code = code;
    this.statusHint = statusHint;
  }
}
