/**
 * STORAGE-9 — CORS serialiser tests.
 *
 * Covers:
 *   - XML serialisation for R2 / B2 / AWS S3 / MinIO / `s3_generic`.
 *   - JSON serialisation for iDrive e2.
 *   - B2 100 KB binding-constraint enforcement on both formats.
 *   - Shape pre-validation runs BEFORE serialisation (so a known-bad
 *     input never wastes serialisation work).
 *   - XML escapes reserved characters in origins / headers.
 *   - JSON output structure matches the AWS S3 field naming (so the
 *     adapter can wire it to the iDrive e2 "Bucket CORS" tab without
 *     remapping).
 *   - Output never carries credentials (it can't — the function takes
 *     a normalised CORS shape only — but this is a regression guard).
 *   - `wireFormatForProvider` returns `'xml'` for every provider except
 *     `idrive_e2`.
 */
import { describe, expect, test } from 'bun:test';
import {
  serialiseCorsConfig,
  wireFormatForProvider,
  STORAGE_CORS_MAX_PAYLOAD_BYTES,
  type CorsWireFormat,
} from '../../src/infra/providers/cors-serialiser';
import { ProviderAdapterError } from '../../src/infra/providers/errors';
import type { CorsConfig } from '../../src/infra/providers/cors-validator';
import type { ProviderKind } from '../../src/infra/providers/types';

const ALL_XML_PROVIDERS: ReadonlyArray<ProviderKind> = [
  'r2',
  'b2',
  'aws_s3',
  's3_generic',
  'minio',
];

const baseConfig: CorsConfig = {
  rules: [
    {
      allowedOrigins: ['https://app.xynes.dev'],
      allowedMethods: ['GET', 'PUT', 'HEAD'],
      allowedHeaders: ['Authorization', 'Content-Type'],
      exposeHeaders: ['ETag'],
      maxAgeSeconds: 3600,
    },
  ],
};

describe('wireFormatForProvider', () => {
  test('iDrive e2 -> json', () => {
    expect(wireFormatForProvider('idrive_e2')).toBe('json');
  });
  for (const providerKind of ALL_XML_PROVIDERS) {
    test(`${providerKind} -> xml`, () => {
      expect(wireFormatForProvider(providerKind)).toBe('xml');
    });
  }
});

describe('serialiseCorsConfig — XML output', () => {
  for (const providerKind of ALL_XML_PROVIDERS) {
    test(`${providerKind} produces well-formed CORS XML`, () => {
      const out = serialiseCorsConfig(baseConfig, providerKind);
      expect(out.format).toBe('xml');
      expect(out.providerKind).toBe(providerKind);
      expect(out.payload).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(out.payload).toContain('<CORSConfiguration>');
      expect(out.payload).toContain('<CORSRule>');
      expect(out.payload).toContain('<AllowedOrigin>https://app.xynes.dev</AllowedOrigin>');
      expect(out.payload).toContain('<AllowedMethod>GET</AllowedMethod>');
      expect(out.payload).toContain('<AllowedMethod>PUT</AllowedMethod>');
      expect(out.payload).toContain('<AllowedMethod>HEAD</AllowedMethod>');
      expect(out.payload).toContain('<AllowedHeader>Authorization</AllowedHeader>');
      expect(out.payload).toContain('<AllowedHeader>Content-Type</AllowedHeader>');
      expect(out.payload).toContain('<ExposeHeader>ETag</ExposeHeader>');
      expect(out.payload).toContain('<MaxAgeSeconds>3600</MaxAgeSeconds>');
      expect(out.payload).toContain('</CORSRule>');
      expect(out.payload).toContain('</CORSConfiguration>');
      expect(out.byteLength).toBe(Buffer.byteLength(out.payload, 'utf8'));
    });
  }

  test('escapes XML reserved characters in origins', () => {
    const config: CorsConfig = {
      rules: [
        {
          allowedOrigins: ['https://app.example/<script>"&\''],
          allowedMethods: ['GET'],
        },
      ],
    };
    const out = serialiseCorsConfig(config, 'r2');
    expect(out.payload).not.toContain('<script>');
    expect(out.payload).toContain('&lt;script&gt;');
    expect(out.payload).toContain('&quot;');
    expect(out.payload).toContain('&amp;');
    expect(out.payload).toContain('&apos;');
  });

  test('omits optional allowedHeaders / exposeHeaders / maxAgeSeconds when absent', () => {
    const minimal: CorsConfig = {
      rules: [
        {
          allowedOrigins: ['https://app.xynes.dev'],
          allowedMethods: ['GET'],
        },
      ],
    };
    const out = serialiseCorsConfig(minimal, 'r2');
    expect(out.payload).not.toContain('<AllowedHeader>');
    expect(out.payload).not.toContain('<ExposeHeader>');
    expect(out.payload).not.toContain('<MaxAgeSeconds>');
  });

  test('emits multiple rules in order', () => {
    const config: CorsConfig = {
      rules: [
        { allowedOrigins: ['https://a.example'], allowedMethods: ['GET'] },
        { allowedOrigins: ['https://b.example'], allowedMethods: ['PUT'] },
      ],
    };
    const out = serialiseCorsConfig(config, 'b2');
    const ruleCount = (out.payload.match(/<CORSRule>/g) ?? []).length;
    expect(ruleCount).toBe(2);
    expect(out.payload.indexOf('https://a.example')).toBeLessThan(
      out.payload.indexOf('https://b.example'),
    );
  });
});

describe('serialiseCorsConfig — JSON output (iDrive e2)', () => {
  test('iDrive e2 produces JSON with AWS S3 field naming', () => {
    const out = serialiseCorsConfig(baseConfig, 'idrive_e2');
    expect(out.format).toBe('json');
    expect(out.providerKind).toBe('idrive_e2');
    const parsed = JSON.parse(out.payload) as {
      CORSRules: Array<{
        AllowedOrigins: string[];
        AllowedMethods: string[];
        AllowedHeaders?: string[];
        ExposeHeaders?: string[];
        MaxAgeSeconds?: number;
      }>;
    };
    expect(parsed.CORSRules).toHaveLength(1);
    expect(parsed.CORSRules[0]?.AllowedOrigins).toEqual(['https://app.xynes.dev']);
    expect(parsed.CORSRules[0]?.AllowedMethods).toEqual(['GET', 'PUT', 'HEAD']);
    expect(parsed.CORSRules[0]?.AllowedHeaders).toEqual(['Authorization', 'Content-Type']);
    expect(parsed.CORSRules[0]?.ExposeHeaders).toEqual(['ETag']);
    expect(parsed.CORSRules[0]?.MaxAgeSeconds).toBe(3600);
  });

  test('omits optional fields when absent', () => {
    const minimal: CorsConfig = {
      rules: [{ allowedOrigins: ['https://app.xynes.dev'], allowedMethods: ['GET'] }],
    };
    const out = serialiseCorsConfig(minimal, 'idrive_e2');
    const parsed = JSON.parse(out.payload) as {
      CORSRules: Array<Record<string, unknown>>;
    };
    expect(parsed.CORSRules[0]).toEqual({
      AllowedOrigins: ['https://app.xynes.dev'],
      AllowedMethods: ['GET'],
    });
  });

  test('JSON does NOT carry credentials', () => {
    const out = serialiseCorsConfig(baseConfig, 'idrive_e2');
    expect(out.payload).not.toContain('accessKeyId');
    expect(out.payload).not.toContain('secretAccessKey');
    expect(out.payload).not.toContain('credentialRef');
  });
});

describe('serialiseCorsConfig — pre-validation', () => {
  test('rejects empty rules array before serialisation', () => {
    expect(() => serialiseCorsConfig({ rules: [] }, 'r2')).toThrow(ProviderAdapterError);
  });

  test('rejects rule with empty allowedOrigins (B2 binding)', () => {
    expect(() =>
      serialiseCorsConfig({ rules: [{ allowedOrigins: [], allowedMethods: ['GET'] }] }, 'r2'),
    ).toThrow(ProviderAdapterError);
  });

  test('rejects maxAgeSeconds > 86400 (B2 binding)', () => {
    expect(() =>
      serialiseCorsConfig(
        {
          rules: [
            {
              allowedOrigins: ['https://x.example'],
              allowedMethods: ['GET'],
              maxAgeSeconds: 100_000,
            },
          ],
        },
        'b2',
      ),
    ).toThrow(ProviderAdapterError);
  });
});

describe('serialiseCorsConfig — B2 100 KB binding constraint on serialised output', () => {
  test('XML output exceeding 100 KB throws PROVIDER_CONFIG_INVALID', () => {
    // Build many rules until we exceed 100 KB.
    const longOrigin = `https://${'a'.repeat(150)}.example.com`;
    const config: CorsConfig = {
      rules: Array.from({ length: 600 }, () => ({
        allowedOrigins: [longOrigin],
        allowedMethods: ['GET'],
      })),
    };
    let thrown: unknown = null;
    try {
      serialiseCorsConfig(config, 'r2');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ProviderAdapterError);
    if (thrown instanceof ProviderAdapterError) {
      expect(thrown.code).toBe('PROVIDER_CONFIG_INVALID');
      expect(thrown.message).toContain('100 KB');
    }
  });

  test('JSON output exceeding 100 KB throws PROVIDER_CONFIG_INVALID', () => {
    const longOrigin = `https://${'a'.repeat(150)}.example.com`;
    const config: CorsConfig = {
      rules: Array.from({ length: 600 }, () => ({
        allowedOrigins: [longOrigin],
        allowedMethods: ['GET'],
      })),
    };
    expect(() => serialiseCorsConfig(config, 'idrive_e2')).toThrow(ProviderAdapterError);
  });

  test('byteLength is the actual UTF-8 byte count', () => {
    const out = serialiseCorsConfig(baseConfig, 'r2');
    expect(out.byteLength).toBe(Buffer.byteLength(out.payload, 'utf8'));
    expect(out.byteLength).toBeLessThan(STORAGE_CORS_MAX_PAYLOAD_BYTES);
  });
});

describe('serialiseCorsConfig — output redaction guard', () => {
  // The function takes a CorsConfig that doesn't carry credentials, but
  // this regression guard ensures the output structure never leaks
  // anything that LOOKS like a credential surface.
  test('XML output contains no provider credential or signature field', () => {
    const out = serialiseCorsConfig(baseConfig, 'r2');
    expect(out.payload).not.toContain('accessKeyId');
    expect(out.payload).not.toContain('secretAccessKey');
    expect(out.payload).not.toContain('credentialRef');
    expect(out.payload).not.toContain('credential_ref');
    expect(out.payload).not.toContain('X-Amz-Signature');
    expect(out.payload).not.toContain('xynes_live_');
  });

  test('JSON output contains no provider credential or signature field', () => {
    const out = serialiseCorsConfig(baseConfig, 'idrive_e2');
    expect(out.payload).not.toContain('accessKeyId');
    expect(out.payload).not.toContain('secretAccessKey');
    expect(out.payload).not.toContain('credentialRef');
    expect(out.payload).not.toContain('credential_ref');
  });
});

describe('serialiseCorsConfig — return shape', () => {
  test('SerialisedCorsConfig.format is a valid CorsWireFormat', () => {
    const validFormats: CorsWireFormat[] = ['xml', 'json'];
    const xmlOut = serialiseCorsConfig(baseConfig, 'r2');
    const jsonOut = serialiseCorsConfig(baseConfig, 'idrive_e2');
    expect(validFormats).toContain(xmlOut.format);
    expect(validFormats).toContain(jsonOut.format);
  });
});
