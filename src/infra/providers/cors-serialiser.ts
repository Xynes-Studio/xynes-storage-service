/**
 * STORAGE-9 — Per-provider CORS serialiser.
 *
 * Storage-service accepts the normalised internal `CorsConfig` shape from
 * `./cors-validator.ts`. The CORS push flow needs to serialise that shape
 * into the wire format each provider expects:
 *
 *   - **R2 / Backblaze B2 / AWS S3 / MinIO**: AWS S3 CORS XML
 *     (`<CORSConfiguration>...<CORSRule>...`).
 *   - **iDrive e2**: JSON, matching the per-bucket "Bucket CORS" tab in
 *     the e2 console. The JSON shape mirrors the AWS S3 fields with the
 *     same capitalisation so adapter wire calls treat it as opaque.
 *
 * The serialiser also re-validates the result against B2's binding
 * limits (serialised payload ≤ 100 KB) so the same input is acceptable
 * on every provider without per-caller branching.
 *
 * Plan §STORAGE-9 acceptance criterion (verbatim):
 *   "CORS is limited to approved Xynes app origins. Storage-service
 *    accepts a normalised internal CORS shape and the adapter serialises
 *    per provider — XML for R2 / B2 / AWS S3 / MinIO, JSON for iDrive e2
 *    (per-bucket 'Bucket CORS' tab). The normalised shape MUST validate
 *    against the tightest of the three MVP-ready provider limits
 *    (Backblaze B2 is the binding constraint: serialised payload ≤ 100
 *    KB, MaxAgeSeconds ∈ [0, 86400], non-empty AllowedOrigin) so the
 *    same input is acceptable on every provider without per-caller
 *    branching."
 *
 * Output forms NEVER include credentials. The serialiser is a pure
 * function of the normalised input.
 */

import type { ProviderKind } from './types';
import { type CorsConfig, validateCorsConfig } from './cors-validator';

/** Wire format the serialiser produces. */
export type CorsWireFormat = 'xml' | 'json';

export interface SerialisedCorsConfig {
  /** `xml` for R2 / B2 / AWS S3 / MinIO; `json` for iDrive e2. */
  readonly format: CorsWireFormat;
  /** Wire payload. UTF-8 encoded. */
  readonly payload: string;
  /** Byte length of `payload` — already checked against the 100 KB B2 limit. */
  readonly byteLength: number;
  /** Provider this payload was serialised for. */
  readonly providerKind: ProviderKind;
}

const B2_MAX_PAYLOAD_BYTES = 100 * 1024;

/**
 * Escape XML reserved characters in attribute / element text. We
 * deliberately do NOT support arbitrary inputs containing control chars
 * or NUL bytes — the validator should reject those upstream, but the
 * escape function is conservative anyway.
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function serialiseCorsXml(config: CorsConfig): string {
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<CORSConfiguration>');
  for (const rule of config.rules) {
    lines.push('  <CORSRule>');
    for (const origin of rule.allowedOrigins) {
      lines.push(`    <AllowedOrigin>${escapeXml(origin)}</AllowedOrigin>`);
    }
    for (const method of rule.allowedMethods) {
      lines.push(`    <AllowedMethod>${escapeXml(method)}</AllowedMethod>`);
    }
    if (rule.allowedHeaders) {
      for (const header of rule.allowedHeaders) {
        lines.push(`    <AllowedHeader>${escapeXml(header)}</AllowedHeader>`);
      }
    }
    if (rule.exposeHeaders) {
      for (const header of rule.exposeHeaders) {
        lines.push(`    <ExposeHeader>${escapeXml(header)}</ExposeHeader>`);
      }
    }
    if (typeof rule.maxAgeSeconds === 'number') {
      lines.push(`    <MaxAgeSeconds>${rule.maxAgeSeconds}</MaxAgeSeconds>`);
    }
    lines.push('  </CORSRule>');
  }
  lines.push('</CORSConfiguration>');
  return lines.join('\n');
}

interface JsonCorsRule {
  readonly AllowedOrigins: ReadonlyArray<string>;
  readonly AllowedMethods: ReadonlyArray<string>;
  readonly AllowedHeaders?: ReadonlyArray<string>;
  readonly ExposeHeaders?: ReadonlyArray<string>;
  readonly MaxAgeSeconds?: number;
}

interface JsonCorsConfig {
  readonly CORSRules: ReadonlyArray<JsonCorsRule>;
}

function serialiseCorsJson(config: CorsConfig): string {
  const rules: JsonCorsRule[] = config.rules.map((rule) => {
    const jsonRule: {
      AllowedOrigins: ReadonlyArray<string>;
      AllowedMethods: ReadonlyArray<string>;
      AllowedHeaders?: ReadonlyArray<string>;
      ExposeHeaders?: ReadonlyArray<string>;
      MaxAgeSeconds?: number;
    } = {
      AllowedOrigins: [...rule.allowedOrigins],
      AllowedMethods: [...rule.allowedMethods],
    };
    if (rule.allowedHeaders && rule.allowedHeaders.length > 0) {
      jsonRule.AllowedHeaders = [...rule.allowedHeaders];
    }
    if (rule.exposeHeaders && rule.exposeHeaders.length > 0) {
      jsonRule.ExposeHeaders = [...rule.exposeHeaders];
    }
    if (typeof rule.maxAgeSeconds === 'number') {
      jsonRule.MaxAgeSeconds = rule.maxAgeSeconds;
    }
    return jsonRule;
  });
  const out: JsonCorsConfig = { CORSRules: rules };
  return JSON.stringify(out);
}

/**
 * Decide the wire format for a provider. R2 / B2 / AWS S3 / MinIO /
 * `s3_generic` all expect AWS S3 XML; iDrive e2 is the lone JSON
 * outlier.
 */
export function wireFormatForProvider(providerKind: ProviderKind): CorsWireFormat {
  return providerKind === 'idrive_e2' ? 'json' : 'xml';
}

/**
 * Serialise a normalised `CorsConfig` for a specific provider.
 *
 * Validation order:
 *   1. Shape validation (`validateCorsConfig` without size hint) — same
 *      checks the validator already runs.
 *   2. Serialisation.
 *   3. Re-validation with the serialised byte length so the B2 100 KB
 *      cap is enforced uniformly across XML and JSON outputs.
 *
 * Throws `ProviderAdapterError(PROVIDER_CONFIG_INVALID)` on any failure.
 * The error message NEVER includes the offending payload — it carries
 * only the size and the rule index when relevant.
 */
export function serialiseCorsConfig(
  config: CorsConfig,
  providerKind: ProviderKind,
): SerialisedCorsConfig {
  // Step 1: shape validation up-front so we never serialise a known-bad
  // shape (the second `validateCorsConfig` call would catch it too, but
  // running it twice is cheap and prevents wasted serialisation work on
  // hostile inputs).
  validateCorsConfig(config);

  const format = wireFormatForProvider(providerKind);
  const payload = format === 'xml' ? serialiseCorsXml(config) : serialiseCorsJson(config);
  const byteLength = Buffer.byteLength(payload, 'utf8');

  // Step 3: re-validate with the actual serialised size so the B2 cap is
  // enforced against the on-wire payload regardless of format.
  validateCorsConfig(config, byteLength);

  return {
    format,
    payload,
    byteLength,
    providerKind,
  };
}

export const STORAGE_CORS_MAX_PAYLOAD_BYTES = B2_MAX_PAYLOAD_BYTES;
