/**
 * STORAGE-9 — storage-service-side redaction mirror.
 *
 * This module is the storage-service equivalent of the gateway's
 * `src/logging/redaction.ts`. It exists so handler errors, worker logs,
 * cleanup-job logs, and any other structured log emission inside
 * storage-service is scrubbed of secret material BEFORE it reaches the
 * gateway log dispatcher. The gateway-side redaction in
 * `xynes-gateway/src/logging/redaction.ts` is defense-in-depth on top of
 * this module — both layers must hold.
 *
 * STORAGE-9 acceptance criterion (verbatim from the plan):
 *   "Logs and error payloads redact, by exact field-name and by content
 *    pattern: signed URLs, raw API keys, accessKeyId, secretAccessKey,
 *    provider credential_ref values, presigned URL signature parameters
 *    (X-Amz-Signature, X-Amz-Credential, X-Amz-Security-Token, X-Amz-Date,
 *    X-Amz-Expires, X-Amz-SignedHeaders), R2 tokens, B2 application keys,
 *    iDrive e2 access keys, sensitive checksums where they could be used
 *    for object enumeration, and internal credential references."
 *
 * Field-name match strategy mirrors the gateway's three tiers:
 *
 *   1. **Loose substring match** for legacy high-risk tokens:
 *      `authorization`, `cookie`, `set-cookie`, `password`, `token`,
 *      `secret`, `x-internal-service-token`, `x-amz-signature`,
 *      `x-amz-credential`, `x-amz-security-token`, `x-amz-date`,
 *      `x-amz-expires`, `x-amz-signedheaders`. Any field name CONTAINING
 *      one of these substrings is redacted.
 *
 *   2. **Anchored exact match** for canonical workspace API-key surfaces
 *      and storage-provider credential surfaces:
 *      `apiKey`, `api_key`, `api-key`, `x-xs-api-key`, `rawKey`,
 *      `raw_key`, `keyHash`, `key_hash`, `accessKeyId`, `access_key_id`,
 *      `secretAccessKey`, `secret_access_key`, `credentialRef`,
 *      `credential_ref`, `r2Token`, `r2_token`.
 *
 *   3. **Loose `apikey` substring** for compound third-party names
 *      (e.g. `x-api-key`, `workspaceApiKey`). Safelisted by the
 *      `Id` / `Prefix` suffix so public audit handles (`apiKeyId`,
 *      `apiKeyPrefix`, `keyPrefix`) remain readable in operator logs.
 *
 * Free-text scrubbing covers (regardless of which field carries them):
 *
 *   - `Bearer <token>` Authorization values.
 *   - Quoted authorization/cookie/internal-service-token/x-xs-api-key/
 *     x-amz-signature header strings serialised into JSON or text bodies.
 *   - Raw workspace API keys of the form `xynes_live_<hex>` (gateway's
 *     `RAW_API_KEY_MARKER` shape).
 *   - Argon2 password / API-key hashes (`$argon2id$...`, `$argon2i$...`,
 *     `$argon2d$...`).
 *   - SigV4 presigned URL signature query parameters
 *     (`X-Amz-Signature=...`, `X-Amz-Credential=...`,
 *     `X-Amz-Security-Token=...`, `X-Amz-Date=...`, `X-Amz-Expires=...`,
 *     `X-Amz-SignedHeaders=...`) inside any signed URL.
 *
 * Public audit handles that MUST remain readable:
 *   - `apiKeyId`, `apiKeyPrefix`, `keyPrefix`, `objectId`,
 *     `workspaceId`, `requestId`, `actionKey`, `actorType`,
 *     `routeId`, `providerKind`-FREE handles such as `providerId`
 *     (the resolved-row UUID, NOT a credential).
 *
 * Matching is case-insensitive. Strings that match the gateway's
 * existing patterns must continue to match here so the two layers stay
 * in lockstep.
 */

const REDACTED_VALUE = '[REDACTED]';

/** High-risk legacy tokens — loose substring match. */
const SENSITIVE_KEY_LOOSE_PATTERN =
  /authorization|cookie|set-cookie|password|token|secret|x-internal-service-token|x-amz-signature|x-amz-credential|x-amz-security-token|x-amz-date|x-amz-expires|x-amz-signedheaders/i;

/**
 * Canonical workspace API-key + storage-provider credential surfaces.
 * Anchored — must match the WHOLE key, not a substring.
 */
const SENSITIVE_KEY_ANCHORED_PATTERN =
  /^(?:(?:x[-_]?xs[-_]?)?api[-_]?key|raw[-_]?key|key[-_]?hash|access[-_]?key[-_]?id|secret[-_]?access[-_]?key|credential[-_]?ref|r2[-_]?token)$/i;

/**
 * Compound `apikey` substring matcher. Matches keys whose name contains
 * the `apikey` substring with any combination of dashes/underscores
 * between `api` and `key` (e.g. `x-api-key`, `workspaceApiKey`).
 */
const SENSITIVE_KEY_APIKEY_SUBSTRING_PATTERN = /api[-_]?key/i;

/**
 * Public audit-handle safelist — when a name matches the `apikey`
 * compound tier AND ends in `Id` / `_id` / `-id` / `Prefix` / `_prefix`
 * / `-prefix`, the value is preserved.
 */
const PUBLIC_AUDIT_HANDLE_SAFELIST_PATTERN = /(?:[a-z]|[-_])(?:id|prefix)$/i;

export function isSensitiveStorageFieldName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (SENSITIVE_KEY_LOOSE_PATTERN.test(name)) return true;
  if (SENSITIVE_KEY_ANCHORED_PATTERN.test(name)) return true;
  if (
    SENSITIVE_KEY_APIKEY_SUBSTRING_PATTERN.test(name) &&
    !PUBLIC_AUDIT_HANDLE_SAFELIST_PATTERN.test(name)
  ) {
    return true;
  }
  return false;
}

/**
 * Free-text patterns that must be scrubbed even when they appear inside
 * non-sensitive fields. Each alternation matches one credential shape.
 *
 * NB: order matters for the `X-Amz-*` parameters — we match
 * `X-Amz-SignedHeaders` BEFORE `X-Amz-Signature` (substring overlap).
 */
const SENSITIVE_TEXT_PATTERN =
  /(bearer\s+[a-z0-9\-._~+/]+=*)|("?(?:authorization|x-internal-service-token|x-xs-api-key|cookie|set-cookie|x-amz-signature|x-amz-credential|x-amz-security-token|x-amz-signedheaders)"?\s*:\s*"[^"]+")|(xynes_live_[a-f0-9]+)|(\$argon2(?:id|i|d)?\$[^\s"']+)|(x-amz-signedheaders=[^&"'\s]+)|(x-amz-signature=[^&"'\s]+)|(x-amz-credential=[^&"'\s]+)|(x-amz-security-token=[^&"'\s]+)|(x-amz-date=\d{8}t\d{6}z)|(x-amz-expires=\d+)/gi;

function redactObjectValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactObjectValue);
  }
  if (value && typeof value === 'object') {
    const input = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(input)) {
      out[key] = isSensitiveStorageFieldName(key) ? REDACTED_VALUE : redactObjectValue(nested);
    }
    return out;
  }
  if (typeof value === 'string') {
    return value.replace(SENSITIVE_TEXT_PATTERN, REDACTED_VALUE);
  }
  return value;
}

/**
 * Apply field-name + free-text redaction to a structured log record.
 * Returns a NEW object; the input is never mutated.
 */
export function redactLogFields(
  fields: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!fields) return fields;
  return redactObjectValue(fields) as Record<string, unknown>;
}

/**
 * Apply free-text redaction to a single string (e.g. an error message
 * or a log-line `message` argument).
 */
export function redactLogMessage(message: string): string {
  if (typeof message !== 'string') return message;
  return message.replace(SENSITIVE_TEXT_PATTERN, REDACTED_VALUE);
}

/**
 * Apply both field-name + free-text redaction to an arbitrary value
 * (used by error-handler when shaping `INTERNAL_ERROR` bodies).
 */
export function redactValue(value: unknown): unknown {
  return redactObjectValue(value);
}

export const REDACTED_VALUE_LITERAL = REDACTED_VALUE;
