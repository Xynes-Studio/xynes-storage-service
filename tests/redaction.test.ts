/**
 * STORAGE-9 — Storage-service redaction tests.
 *
 * Mirrors the gateway's `redaction.test.ts` for the field-name + free-text
 * matching, then extends with storage-specific surfaces:
 *
 *   - SigV4 presigned URL signature query parameters
 *     (`X-Amz-Signature`, `X-Amz-Credential`, `X-Amz-Security-Token`,
 *     `X-Amz-Date`, `X-Amz-Expires`, `X-Amz-SignedHeaders`).
 *   - Provider credential surfaces (`accessKeyId`, `secretAccessKey`,
 *     `credentialRef`, `r2Token`).
 *   - Public audit handles that MUST remain readable (`apiKeyId`,
 *     `keyPrefix`, `providerId`, `objectId`, `workspaceId`).
 *
 * Cross-provider redaction matrix: each invariant is asserted against
 * fake R2 / B2 / iDrive e2 / AWS S3 / MinIO configs to prove redaction
 * applies uniformly regardless of `providerKind`.
 */
import { describe, expect, test } from 'bun:test';
import {
  isSensitiveStorageFieldName,
  redactLogFields,
  redactLogMessage,
  redactValue,
  REDACTED_VALUE_LITERAL,
} from '../src/infra/redaction';
import type { ProviderKind } from '../src/infra/providers/types';

const ALL_PROVIDER_KINDS: ReadonlyArray<ProviderKind> = [
  'r2',
  'b2',
  'idrive_e2',
  'aws_s3',
  's3_generic',
  'minio',
];

describe('isSensitiveStorageFieldName — loose tier', () => {
  const sensitive = [
    'authorization',
    'Authorization',
    'AUTHORIZATION',
    'cookie',
    'set-cookie',
    'password',
    'userPassword',
    'token',
    'accessToken',
    'refreshToken',
    'secret',
    'mySecret',
    'x-internal-service-token',
    'X-Internal-Service-Token',
    'x-amz-signature',
    'X-Amz-Signature',
    'x-amz-credential',
    'x-amz-security-token',
    'x-amz-date',
    'x-amz-expires',
    'x-amz-signedheaders',
  ];
  for (const name of sensitive) {
    test(`redacts "${name}"`, () => {
      expect(isSensitiveStorageFieldName(name)).toBe(true);
    });
  }
});

describe('isSensitiveStorageFieldName — anchored tier', () => {
  const sensitive = [
    'apiKey',
    'api_key',
    'api-key',
    'x-xs-api-key',
    'rawKey',
    'raw_key',
    'keyHash',
    'key_hash',
    'accessKeyId',
    'access_key_id',
    'secretAccessKey',
    'secret_access_key',
    'credentialRef',
    'credential_ref',
    'r2Token',
    'r2_token',
  ];
  for (const name of sensitive) {
    test(`redacts "${name}"`, () => {
      expect(isSensitiveStorageFieldName(name)).toBe(true);
    });
  }
});

describe('isSensitiveStorageFieldName — compound apikey tier', () => {
  const sensitive = ['x-api-key', 'workspaceApiKey', 'customer_api_key', 'third-party-api-key'];
  for (const name of sensitive) {
    test(`redacts compound "${name}"`, () => {
      expect(isSensitiveStorageFieldName(name)).toBe(true);
    });
  }
});

describe('isSensitiveStorageFieldName — public audit handle safelist', () => {
  const preserved = [
    'apiKeyId',
    'api_key_id',
    'api-key-id',
    'apiKeyPrefix',
    'api_key_prefix',
    'api-key-prefix',
    'keyPrefix',
    'key_prefix',
    'key-prefix',
  ];
  for (const name of preserved) {
    test(`preserves audit handle "${name}"`, () => {
      expect(isSensitiveStorageFieldName(name)).toBe(false);
    });
  }
});

describe('isSensitiveStorageFieldName — storage-specific audit handles', () => {
  // These are NEVER sensitive — they're public identifiers the dashboard
  // and operator logs rely on. Defense-in-depth regression guard.
  const preserved = [
    'objectId',
    'workspaceId',
    'requestId',
    'actionKey',
    'actorType',
    'routeId',
    'providerId',
    'providerKind',
    'uploadId',
    'sessionId',
    'jobId',
    'variantId',
    'role',
    'status',
    'filename',
    'contentType',
    'byteSize',
  ];
  for (const name of preserved) {
    test(`preserves audit handle "${name}"`, () => {
      expect(isSensitiveStorageFieldName(name)).toBe(false);
    });
  }
});

describe('isSensitiveStorageFieldName — defensive', () => {
  test('non-string returns false', () => {
    expect(isSensitiveStorageFieldName(undefined as unknown as string)).toBe(false);
    expect(isSensitiveStorageFieldName(null as unknown as string)).toBe(false);
    expect(isSensitiveStorageFieldName(123 as unknown as string)).toBe(false);
  });
  test('empty string returns false', () => {
    expect(isSensitiveStorageFieldName('')).toBe(false);
  });
});

describe('redactLogFields — object-form sensitive keys', () => {
  test('redacts every documented sensitive field', () => {
    const input = {
      requestId: 'req-123',
      workspaceId: 'ws-abc',
      accessKeyId: 'AKIA-LEAK-1234',
      secretAccessKey: 'super-secret-key-DO-NOT-LEAK',
      credentialRef: 'secret://xynes/storage/r2-dev',
      r2Token: 'r2-token-value-do-not-leak',
      authorization: 'Bearer eyJ.something.something',
      apiKey: 'xynes_live_abc123',
      rawKey: 'xynes_live_xyz789',
      keyHash: '$argon2id$v=19$...',
      'x-amz-signature': 'abcdef0123456789',
    };
    const out = redactLogFields(input) as Record<string, unknown>;
    expect(out.requestId).toBe('req-123');
    expect(out.workspaceId).toBe('ws-abc');
    expect(out.accessKeyId).toBe(REDACTED_VALUE_LITERAL);
    expect(out.secretAccessKey).toBe(REDACTED_VALUE_LITERAL);
    expect(out.credentialRef).toBe(REDACTED_VALUE_LITERAL);
    expect(out.r2Token).toBe(REDACTED_VALUE_LITERAL);
    expect(out.authorization).toBe(REDACTED_VALUE_LITERAL);
    expect(out.apiKey).toBe(REDACTED_VALUE_LITERAL);
    expect(out.rawKey).toBe(REDACTED_VALUE_LITERAL);
    expect(out.keyHash).toBe(REDACTED_VALUE_LITERAL);
    expect(out['x-amz-signature']).toBe(REDACTED_VALUE_LITERAL);
  });

  test('preserves audit handles even when nested', () => {
    const input = {
      actor: {
        kind: 'api_key',
        apiKeyId: '4a8b8c0e-1111-2222-3333-44445555aaaa',
        keyPrefix: 'abcd1234',
      },
      object: {
        objectId: '00000000-1111-2222-3333-444444444444',
        providerId: 'aaaa1111-bbbb-2222-cccc-3333dddd4444',
      },
    };
    const out = redactLogFields(input) as Record<string, unknown>;
    const actor = out.actor as Record<string, unknown>;
    expect(actor.apiKeyId).toBe('4a8b8c0e-1111-2222-3333-44445555aaaa');
    expect(actor.keyPrefix).toBe('abcd1234');
    const obj = out.object as Record<string, unknown>;
    expect(obj.objectId).toBe('00000000-1111-2222-3333-444444444444');
    expect(obj.providerId).toBe('aaaa1111-bbbb-2222-cccc-3333dddd4444');
  });

  test('handles nested objects + arrays', () => {
    const input = {
      headers: {
        Authorization: 'Bearer abc.def.ghi',
      },
      parts: [
        { partNumber: 1, etag: 'aaa' },
        { partNumber: 2, etag: 'bbb', signature: 'leak-me' },
      ],
    };
    const out = redactLogFields(input) as Record<string, unknown>;
    expect((out.headers as Record<string, unknown>).Authorization).toBe(REDACTED_VALUE_LITERAL);
    const parts = out.parts as Array<Record<string, unknown>>;
    expect(parts[0]?.etag).toBe('aaa');
    expect(parts[1]?.etag).toBe('bbb');
    // `signature` matches loose `x-amz-signature`? No — it doesn't. But
    // free-text scrub doesn't touch it either since it's a bare value.
    // This test pins the boundary: we don't over-scrub arbitrary field
    // names.
    expect(parts[1]?.signature).toBe('leak-me');
  });

  test('returns undefined for undefined input', () => {
    expect(redactLogFields(undefined)).toBeUndefined();
  });
});

describe('redactLogMessage — free-text patterns', () => {
  test('scrubs raw xynes_live_<hex> API keys', () => {
    const out = redactLogMessage('Caller used key xynes_live_abc123def456');
    expect(out).toBe(`Caller used key ${REDACTED_VALUE_LITERAL}`);
  });
  test('scrubs Argon2 hashes', () => {
    const out = redactLogMessage('hash=$argon2id$v=19$m=19456,t=2,p=1$saltbytes$hashbytes');
    expect(out).toContain(REDACTED_VALUE_LITERAL);
    expect(out).not.toContain('$argon2id$');
  });
  test('scrubs Bearer tokens', () => {
    const out = redactLogMessage('Authorization: Bearer eyJhbGc.eyJpYXQ.signature');
    expect(out).toContain(REDACTED_VALUE_LITERAL);
    expect(out).not.toContain('eyJhbGc');
  });
  test('scrubs SigV4 X-Amz-Signature query param', () => {
    const out = redactLogMessage(
      'https://r2.fake/bucket/key?X-Amz-Signature=abc123def456&X-Amz-Credential=AKIA/20260514/...&X-Amz-Date=20260514T120000Z&X-Amz-Expires=900&X-Amz-SignedHeaders=host',
    );
    expect(out).not.toContain('abc123def456');
    expect(out).not.toContain('AKIA/20260514');
    expect(out).not.toContain('X-Amz-Signature=abc123');
    expect(out).not.toContain('X-Amz-Credential=AKIA');
    expect(out).not.toContain('X-Amz-Date=20260514');
    expect(out).not.toContain('X-Amz-Expires=900');
    expect(out).not.toContain('X-Amz-SignedHeaders=host');
  });
  test('scrubs quoted authorization header in JSON', () => {
    const out = redactLogMessage('{"headers":{"authorization":"Bearer leak.token.here"}}');
    expect(out).not.toContain('leak.token.here');
    expect(out).toContain(REDACTED_VALUE_LITERAL);
  });
  test('scrubs quoted x-xs-api-key header in JSON', () => {
    const out = redactLogMessage('{"x-xs-api-key":"xynes_live_secret"}');
    expect(out).not.toContain('xynes_live_secret');
  });
  test('non-string returns input unchanged', () => {
    expect(redactLogMessage(null as unknown as string)).toBeNull();
    expect(redactLogMessage(undefined as unknown as string)).toBeUndefined();
  });
  test('regular log message passes through unchanged', () => {
    const msg = 'Upload session 4a8b-1111 transitioned to completed';
    expect(redactLogMessage(msg)).toBe(msg);
  });
});

describe('redactValue — combined object + text scrubbing', () => {
  test('scrubs raw API key inside non-sensitive field name', () => {
    const out = redactValue({
      message: 'audit log entry: caller used xynes_live_abc123',
    }) as Record<string, unknown>;
    expect(out.message).toContain(REDACTED_VALUE_LITERAL);
    expect(out.message).not.toContain('xynes_live_abc123');
  });
  test('scrubs SigV4 params inside non-sensitive uploadUrl field name', () => {
    // `uploadUrl` is NOT a sensitive field name (presigned URLs are
    // returned to callers by design). But the SigV4 query params
    // embedded INSIDE the URL string get scrubbed by the free-text
    // pattern in case the URL ends up in a log line.
    const out = redactValue({
      uploadUrl: 'https://r2.fake/bucket/key?X-Amz-Signature=leakme&X-Amz-Expires=900',
    }) as Record<string, unknown>;
    expect(out.uploadUrl).not.toContain('leakme');
    expect(out.uploadUrl).not.toContain('X-Amz-Signature=leakme');
  });
});

describe('cross-provider redaction matrix', () => {
  for (const providerKind of ALL_PROVIDER_KINDS) {
    test(`provider=${providerKind} — provider config never survives redaction`, () => {
      const hostileLog = {
        providerKind,
        endpoint: 'https://fake.example/bucket',
        region: 'auto',
        bucket: 'fake-bucket',
        accessKeyId: 'AKIA-FIXTURE-ACCESS-KEY',
        secretAccessKey: 'fixture-secret-key-DO-NOT-LEAK',
        credentialRef: `secret://xynes/storage/${providerKind}-dev`,
      };
      const out = redactLogFields(hostileLog) as Record<string, unknown>;
      // Audit-safe metadata stays readable.
      expect(out.providerKind).toBe(providerKind);
      expect(out.endpoint).toBe('https://fake.example/bucket');
      expect(out.region).toBe('auto');
      expect(out.bucket).toBe('fake-bucket');
      // Credentials always scrubbed.
      expect(out.accessKeyId).toBe(REDACTED_VALUE_LITERAL);
      expect(out.secretAccessKey).toBe(REDACTED_VALUE_LITERAL);
      expect(out.credentialRef).toBe(REDACTED_VALUE_LITERAL);
    });
    test(`provider=${providerKind} — serialised log never carries any forbidden field`, () => {
      const out = redactLogFields({
        providerKind,
        accessKeyId: 'AKIA-LEAK-1234',
        secretAccessKey: 'leak-me',
        credentialRef: 'leak-ref',
        r2Token: 'r2-leak',
        apiKey: 'xynes_live_aaa',
      });
      const serialised = JSON.stringify(out);
      expect(serialised).not.toContain('AKIA-LEAK-1234');
      expect(serialised).not.toContain('leak-me');
      expect(serialised).not.toContain('leak-ref');
      expect(serialised).not.toContain('r2-leak');
      expect(serialised).not.toContain('xynes_live_aaa');
    });
  }
});
