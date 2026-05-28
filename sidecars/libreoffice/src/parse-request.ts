/**
 * STORAGE-FU-5-FU-G — Request parsing.
 *
 * Strict, byte-bounded JSON parsing for `POST /convert`. Closed-set
 * error codes returned on every failure path. Raw request payloads
 * NEVER leak into error messages.
 */
import { MAX_DOCUMENT_BYTES } from './safe-mime';
import { SHIM_ERROR_CODES, type ShimErrorCode } from './errors';

/** Parsed and validated request shape. */
export interface ParsedConvertRequest {
  readonly sourceContentType: string;
  readonly bytes: Uint8Array;
}

/** Maximum on-the-wire JSON body size. Base64 inflates raw bytes by ~4/3 + JSON envelope overhead. */
export const MAX_REQUEST_BODY_BYTES = Math.ceil((MAX_DOCUMENT_BYTES * 4) / 3) + 4096;

export type ParseConvertResult =
  | { ok: true; value: ParsedConvertRequest }
  | { ok: false; code: ShimErrorCode };

/**
 * Parse and validate a JSON convert request body. Returns the decoded
 * `Uint8Array` of bytes ready for the convert handler.
 *
 * All failure paths surface as closed-set codes:
 *   - INVALID_JSON     — body is not parseable JSON or wrong shape
 *   - MISSING_FIELD    — required field absent or wrong type
 *   - UNSUPPORTED_FORMAT — empty sourceContentType (allowlist re-check happens later)
 *   - INVALID_BASE64   — bytes field is not valid base64
 *   - OVER_MAX_BYTES   — decoded payload exceeds MAX_DOCUMENT_BYTES
 */
export function parseConvertRequest(raw: string): ParseConvertResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: SHIM_ERROR_CODES.INVALID_JSON };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, code: SHIM_ERROR_CODES.INVALID_JSON };
  }

  const obj = parsed as Record<string, unknown>;
  const sourceContentType = obj.sourceContentType;
  const bytesField = obj.bytes;

  if (typeof sourceContentType !== 'string' || sourceContentType.length === 0) {
    return { ok: false, code: SHIM_ERROR_CODES.MISSING_FIELD };
  }
  if (typeof bytesField !== 'string' || bytesField.length === 0) {
    return { ok: false, code: SHIM_ERROR_CODES.MISSING_FIELD };
  }

  // Decode base64. Bun + Node both expose `Buffer.from(s, 'base64')`,
  // which silently drops invalid characters — defense in depth: we
  // round-trip the decoded bytes back to base64 and reject when the
  // canonical re-encoding doesn't match (modulo padding).
  let decoded: Uint8Array;
  try {
    decoded = decodeBase64Strict(bytesField);
  } catch {
    return { ok: false, code: SHIM_ERROR_CODES.INVALID_BASE64 };
  }

  if (decoded.byteLength > MAX_DOCUMENT_BYTES) {
    return { ok: false, code: SHIM_ERROR_CODES.OVER_MAX_BYTES };
  }

  return {
    ok: true,
    value: { sourceContentType, bytes: decoded },
  };
}

/**
 * Strict-ish base64 decoder. `Buffer.from(s, 'base64')` is lenient by
 * default — it silently strips non-base64 characters, which makes
 * malformed input look like a successful decode. We re-encode the
 * result and demand it equals the trimmed input (with the standard
 * padding rules) before accepting.
 *
 * This is enough to catch the common shape errors (random ascii,
 * JSON-escaped characters, etc.) without rejecting line-wrapped input
 * the client may legitimately send.
 */
function decodeBase64Strict(value: string): Uint8Array {
  // Strip whitespace + newlines (MIME-style line wrapping is allowed).
  const compact = value.replace(/\s+/g, '');
  // Allowed characters: A-Z a-z 0-9 + / = (only as trailing padding).
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new Error('INVALID_BASE64');
  }
  // Length must be a multiple of 4 (with padding).
  if (compact.length % 4 !== 0) {
    throw new Error('INVALID_BASE64');
  }
  const decoded = Buffer.from(compact, 'base64');
  // Re-encode + compare to catch the rare case where Buffer.from
  // silently accepted weird input.
  const reEncoded = decoded.toString('base64');
  if (reEncoded !== compact) {
    throw new Error('INVALID_BASE64');
  }
  return new Uint8Array(decoded);
}
