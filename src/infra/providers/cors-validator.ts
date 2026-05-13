/**
 * Normalised internal CORS shape — provider-agnostic.
 *
 * Plan §3 + STORAGE-9: storage-service accepts this shape and the adapter
 * serialises per provider (XML for R2 / B2 / AWS S3 / MinIO, JSON for
 * iDrive e2). The normalised shape MUST validate against the tightest of
 * the three MVP-ready provider limits — Backblaze B2 — so the same input
 * works on every provider without per-caller branching.
 *
 * Backblaze B2 limits (binding):
 *   - serialised XML payload ≤ 100 KB
 *   - `MaxAgeSeconds` ∈ [0, 86400]
 *   - `AllowedOrigin` MUST be non-empty
 *
 * STORAGE-4 ships the validator only — provider-specific serialisation
 * lands with STORAGE-9 when the live CORS push flow is wired.
 */
import { ProviderAdapterError } from './errors';

export interface CorsRule {
  readonly allowedOrigins: ReadonlyArray<string>;
  readonly allowedMethods: ReadonlyArray<'GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD'>;
  readonly allowedHeaders?: ReadonlyArray<string>;
  readonly exposeHeaders?: ReadonlyArray<string>;
  readonly maxAgeSeconds?: number;
}

export interface CorsConfig {
  readonly rules: ReadonlyArray<CorsRule>;
}

const B2_MAX_PAYLOAD_BYTES = 100 * 1024;
const B2_MAX_MAX_AGE_SECONDS = 86_400;

/**
 * Validates a `CorsConfig` against the tightest of the three MVP-ready
 * provider limits. Returns silently on success; throws
 * `ProviderAdapterError(PROVIDER_CONFIG_INVALID)` on failure with a stable,
 * caller-safe message.
 *
 * The `serialisedSizeBytes` argument lets a future serialiser pass the
 * actual XML/JSON byte count to be checked against the 100 KB limit
 * without coupling the validator to a specific serialiser.
 */
export function validateCorsConfig(config: CorsConfig, serialisedSizeBytes?: number): void {
  if (!Array.isArray(config.rules) || config.rules.length === 0) {
    throw new ProviderAdapterError(
      'PROVIDER_CONFIG_INVALID',
      'CORS configuration requires at least one rule',
    );
  }

  for (const [idx, rule] of config.rules.entries()) {
    if (!Array.isArray(rule.allowedOrigins) || rule.allowedOrigins.length === 0) {
      throw new ProviderAdapterError(
        'PROVIDER_CONFIG_INVALID',
        `CORS rule #${idx + 1} must have at least one AllowedOrigin (B2 binding constraint)`,
      );
    }
    for (const origin of rule.allowedOrigins) {
      if (typeof origin !== 'string' || origin.trim().length === 0) {
        throw new ProviderAdapterError(
          'PROVIDER_CONFIG_INVALID',
          `CORS rule #${idx + 1} contains an empty AllowedOrigin (B2 binding constraint)`,
        );
      }
    }
    if (!Array.isArray(rule.allowedMethods) || rule.allowedMethods.length === 0) {
      throw new ProviderAdapterError(
        'PROVIDER_CONFIG_INVALID',
        `CORS rule #${idx + 1} must have at least one AllowedMethod`,
      );
    }
    if (rule.maxAgeSeconds !== undefined) {
      if (
        !Number.isInteger(rule.maxAgeSeconds) ||
        rule.maxAgeSeconds < 0 ||
        rule.maxAgeSeconds > B2_MAX_MAX_AGE_SECONDS
      ) {
        throw new ProviderAdapterError(
          'PROVIDER_CONFIG_INVALID',
          `CORS rule #${idx + 1} MaxAgeSeconds must be in [0, ${B2_MAX_MAX_AGE_SECONDS}] (B2 binding constraint)`,
        );
      }
    }
  }

  if (typeof serialisedSizeBytes === 'number' && serialisedSizeBytes > B2_MAX_PAYLOAD_BYTES) {
    throw new ProviderAdapterError(
      'PROVIDER_CONFIG_INVALID',
      `Serialised CORS payload (${serialisedSizeBytes} bytes) exceeds the 100 KB B2 limit`,
    );
  }
}
