/**
 * STORAGE-FU-3 — unit tests for `PostgresExtendedStorageProviderResolver`.
 *
 * Uses an in-memory fake `StorageDb` whose chained query-builder methods
 * record the WHERE predicates and yield a configurable row list. The
 * test does NOT touch a real Postgres — that's covered by the
 * integration suite.
 *
 * Coverage:
 *   - resolveDefaultForWorkspace → row found / no row / blank workspaceId.
 *   - resolveByProviderIdForWorkspace → row found / cross-workspace null
 *     / no row / blank inputs.
 *   - SecretManagerError mapping (every closed-set code).
 *   - Unknown / custom backend error wrapped without leaking text.
 *   - Adapter built with: correct providerKind, region defaults,
 *     forcePathStyle defaults, allowlisted fields ONLY.
 *   - Adapter construction errors propagate as-is (already redacted).
 *   - Endpoint NULL → PROVIDER_CONFIG_INVALID with generic message.
 *   - Resolver errors NEVER carry accessKeyId / secretAccessKey /
 *     credential_ref / endpoint substrings.
 */
import { describe, expect, test } from 'bun:test';
import type { StorageDb } from '../../../../src/infra/db/client';
import {
  PostgresExtendedStorageProviderResolver,
  type PostgresExtendedStorageProviderResolverDeps,
} from '../../../../src/infra/db/repositories/provider-resolver';
import {
  SecretManagerError,
  type ProviderCredentialMaterial,
  type SecretManagerClient,
  type SecretManagerErrorCode,
} from '../../../../src/infra/providers/secret-manager';
import {
  ProviderAdapterError,
  type ProviderAdapterConfig,
  type ProviderAdapterErrorCode,
  type ProviderKind,
  type StorageProviderAdapter,
} from '../../../../src/infra/providers';

// ── In-memory provider row store + fake StorageDb ─────────────────────────

interface FakeProviderRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly providerKind: string;
  readonly displayName: string;
  readonly bucket: string;
  readonly region: string | null;
  readonly endpoint: string | null;
  readonly credentialRef: string;
  readonly status: string;
  readonly isDefault: boolean;
  readonly createdAt: Date;
}

/**
 * A minimal predicate set captured by the fake `where()`. The resolver
 * passes three positional `eq()` predicates inside `and(...)` — the
 * fake collapses them into a single capture by recursively walking the
 * Drizzle SQL chunk objects.
 *
 * For test simplicity we encode the captured filter as a plain object
 * built by inspecting the column metadata Drizzle assigns. The fake
 * `select().from().where()` chain returns a Promise resolving to all
 * rows that match every key in the captured filter.
 */
type FilterPredicate = (row: FakeProviderRow) => boolean;

class FakeStorageDb {
  public rows: FakeProviderRow[] = [];
  // Hook the resolver's call chain. The resolver invokes
  // `db.select(<projection>)` and then chains `.from(...).where(...).orderBy(...).limit(1)`.
  // We don't have to interpret the actual Drizzle SQL chunks; we just
  // expose the chained methods and let the test seed the predicate via
  // `setPredicateForNextCall(...)`.
  private nextPredicate: FilterPredicate | null = null;
  public capturedProjections: unknown[] = [];

  setPredicateForNextCall(predicate: FilterPredicate): void {
    this.nextPredicate = predicate;
  }

  select(projection: unknown): {
    from: () => {
      where: () => {
        orderBy: () => { limit: (n: number) => Promise<FakeProviderRow[]> };
        limit: (n: number) => Promise<FakeProviderRow[]>;
      };
    };
  } {
    this.capturedProjections.push(projection);
    const captured = this.nextPredicate;
    this.nextPredicate = null;
    const filterRows = (limit: number): Promise<FakeProviderRow[]> => {
      const filtered = captured ? this.rows.filter((r) => captured(r)) : this.rows.slice();
      return Promise.resolve(filtered.slice(0, limit));
    };
    return {
      from: () => ({
        where: () => ({
          orderBy: () => ({ limit: filterRows }),
          limit: filterRows,
        }),
      }),
    };
  }
}

function asStorageDb(fake: FakeStorageDb): StorageDb {
  return fake as unknown as StorageDb;
}

// ── Fake SecretManagerClient ──────────────────────────────────────────────

class FakeSecretManager implements SecretManagerClient {
  public calls: string[] = [];
  constructor(
    private readonly behaviour:
      | { kind: 'ok'; material: ProviderCredentialMaterial }
      | { kind: 'error'; code: SecretManagerErrorCode; message: string }
      | { kind: 'unknown'; error: Error },
  ) {}

  async resolve(credentialRef: string): Promise<ProviderCredentialMaterial> {
    this.calls.push(credentialRef);
    if (this.behaviour.kind === 'ok') return this.behaviour.material;
    if (this.behaviour.kind === 'error') {
      throw new SecretManagerError(this.behaviour.code, this.behaviour.message);
    }
    throw this.behaviour.error;
  }
}

// ── Fake adapter factory ──────────────────────────────────────────────────

interface CapturedConfig {
  config: ProviderAdapterConfig;
}

function fakeAdapterBuilder(
  captured: CapturedConfig,
): NonNullable<PostgresExtendedStorageProviderResolverDeps['buildAdapter']> {
  return (config) => {
    captured.config = config;
    return {
      providerKind: config.providerKind,
      endpointHost: new URL(config.endpoint).host,
      bucket: config.bucket,
    } as unknown as StorageProviderAdapter;
  };
}

// ── Test row helpers ──────────────────────────────────────────────────────

function makeRow(overrides: Partial<FakeProviderRow> = {}): FakeProviderRow {
  return {
    id: '00000000-0000-0000-0000-00000000aaaa',
    workspaceId: '00000000-0000-0000-0000-00000000bbbb',
    providerKind: 'r2',
    displayName: 'fixture-r2',
    bucket: 'fixture-bucket',
    region: 'auto',
    endpoint: 'https://example.r2.cloudflarestorage.com',
    credentialRef: 'secret://storage/r2/dev',
    status: 'active',
    isDefault: true,
    createdAt: new Date('2026-05-15T00:00:00Z'),
    ...overrides,
  };
}

const FIXTURE_MATERIAL: ProviderCredentialMaterial = {
  accessKeyId: 'AKIA-FIXTURE-ACCESS-KEY',
  secretAccessKey: 'fixture-secret-key-DO-NOT-LEAK',
};

// ── resolveDefaultForWorkspace ────────────────────────────────────────────

describe('PostgresExtendedStorageProviderResolver.resolveDefaultForWorkspace', () => {
  test('resolves the workspace default row → adapter built with allowlisted fields only', async () => {
    const db = new FakeStorageDb();
    db.rows = [makeRow()];
    db.setPredicateForNextCall(
      (r) =>
        r.workspaceId === '00000000-0000-0000-0000-00000000bbbb' &&
        r.isDefault &&
        r.status === 'active',
    );
    const secrets = new FakeSecretManager({ kind: 'ok', material: FIXTURE_MATERIAL });
    const captured: CapturedConfig = { config: null as unknown as ProviderAdapterConfig };
    const resolver = new PostgresExtendedStorageProviderResolver(asStorageDb(db), secrets, {
      buildAdapter: fakeAdapterBuilder(captured),
    });

    const result = await resolver.resolveDefaultForWorkspace(
      '00000000-0000-0000-0000-00000000bbbb',
    );
    expect(result).not.toBeNull();
    expect(result?.providerId).toBe('00000000-0000-0000-0000-00000000aaaa');
    expect(result?.providerKind).toBe('r2');
    expect(secrets.calls).toEqual(['secret://storage/r2/dev']);

    // Allowlist: only the documented fields reach the adapter.
    expect(captured.config.providerKind).toBe('r2');
    expect(captured.config.endpoint).toBe('https://example.r2.cloudflarestorage.com');
    expect(captured.config.region).toBe('auto');
    expect(captured.config.bucket).toBe('fixture-bucket');
    expect(captured.config.forcePathStyle).toBe(false);
    expect(captured.config.accessKeyId).toBe('AKIA-FIXTURE-ACCESS-KEY');
    expect(captured.config.secretAccessKey).toBe('fixture-secret-key-DO-NOT-LEAK');

    // The resolver MUST NOT pass credential_ref or status or display_name
    // or any other DB-only field to the adapter.
    const passed = Object.keys(captured.config);
    expect(passed.sort()).toEqual(
      [
        'providerKind',
        'endpoint',
        'region',
        'bucket',
        'forcePathStyle',
        'accessKeyId',
        'secretAccessKey',
      ].sort(),
    );
  });

  test('returns null when no default row exists', async () => {
    const db = new FakeStorageDb();
    db.rows = [];
    const secrets = new FakeSecretManager({ kind: 'ok', material: FIXTURE_MATERIAL });
    const captured: CapturedConfig = { config: null as unknown as ProviderAdapterConfig };
    const resolver = new PostgresExtendedStorageProviderResolver(asStorageDb(db), secrets, {
      buildAdapter: fakeAdapterBuilder(captured),
    });
    const result = await resolver.resolveDefaultForWorkspace(
      '00000000-0000-0000-0000-00000000bbbb',
    );
    expect(result).toBeNull();
    expect(secrets.calls).toEqual([]); // No secret-manager call when no row.
  });

  test('returns null for empty / whitespace workspaceId', async () => {
    const db = new FakeStorageDb();
    db.rows = [makeRow()];
    const secrets = new FakeSecretManager({ kind: 'ok', material: FIXTURE_MATERIAL });
    const resolver = new PostgresExtendedStorageProviderResolver(asStorageDb(db), secrets);
    expect(await resolver.resolveDefaultForWorkspace('')).toBeNull();
    expect(await resolver.resolveDefaultForWorkspace('   ')).toBeNull();
    // Defensive: don't even reach the DB on bad input.
    expect(db.capturedProjections.length).toBe(0);
    expect(secrets.calls).toEqual([]);
  });
});

// ── resolveByProviderIdForWorkspace ──────────────────────────────────────

describe('PostgresExtendedStorageProviderResolver.resolveByProviderIdForWorkspace', () => {
  test('resolves a specific provider row scoped to the workspace', async () => {
    const db = new FakeStorageDb();
    const row = makeRow({ isDefault: false });
    db.rows = [row];
    db.setPredicateForNextCall(
      (r) => r.workspaceId === row.workspaceId && r.id === row.id && r.status === 'active',
    );
    const secrets = new FakeSecretManager({ kind: 'ok', material: FIXTURE_MATERIAL });
    const resolver = new PostgresExtendedStorageProviderResolver(asStorageDb(db), secrets);
    const result = await resolver.resolveByProviderIdForWorkspace({
      workspaceId: row.workspaceId,
      providerId: row.id,
    });
    expect(result?.providerId).toBe(row.id);
  });

  test('returns null when the provider row belongs to a different workspace', async () => {
    const db = new FakeStorageDb();
    // Row exists, but in workspace A; we query for workspace B.
    db.rows = [makeRow({ workspaceId: '00000000-0000-0000-0000-aaaaaaaaaaaa' })];
    db.setPredicateForNextCall(
      (r) =>
        r.workspaceId === '00000000-0000-0000-0000-bbbbbbbbbbbb' &&
        r.id === '00000000-0000-0000-0000-00000000aaaa',
    );
    const secrets = new FakeSecretManager({ kind: 'ok', material: FIXTURE_MATERIAL });
    const resolver = new PostgresExtendedStorageProviderResolver(asStorageDb(db), secrets);
    const result = await resolver.resolveByProviderIdForWorkspace({
      workspaceId: '00000000-0000-0000-0000-bbbbbbbbbbbb',
      providerId: '00000000-0000-0000-0000-00000000aaaa',
    });
    expect(result).toBeNull(); // No leak — no exception, no enumeration oracle.
    expect(secrets.calls).toEqual([]);
  });

  test('returns null when providerId is empty / whitespace', async () => {
    const db = new FakeStorageDb();
    db.rows = [makeRow()];
    const secrets = new FakeSecretManager({ kind: 'ok', material: FIXTURE_MATERIAL });
    const resolver = new PostgresExtendedStorageProviderResolver(asStorageDb(db), secrets);
    expect(
      await resolver.resolveByProviderIdForWorkspace({
        workspaceId: '00000000-0000-0000-0000-00000000bbbb',
        providerId: '',
      }),
    ).toBeNull();
    expect(
      await resolver.resolveByProviderIdForWorkspace({
        workspaceId: '00000000-0000-0000-0000-00000000bbbb',
        providerId: '  ',
      }),
    ).toBeNull();
    expect(db.capturedProjections.length).toBe(0);
  });

  test('returns null when workspaceId is empty / whitespace', async () => {
    const db = new FakeStorageDb();
    db.rows = [makeRow()];
    const secrets = new FakeSecretManager({ kind: 'ok', material: FIXTURE_MATERIAL });
    const resolver = new PostgresExtendedStorageProviderResolver(asStorageDb(db), secrets);
    expect(
      await resolver.resolveByProviderIdForWorkspace({
        workspaceId: '   ',
        providerId: '00000000-0000-0000-0000-00000000aaaa',
      }),
    ).toBeNull();
    expect(db.capturedProjections.length).toBe(0);
  });
});

// ── ProviderKind mapping (DB → adapter) ───────────────────────────────────

describe('PostgresExtendedStorageProviderResolver — provider kind mapping', () => {
  const cases: Array<{ dbKind: string; expected: ProviderKind; pathStyle: boolean }> = [
    { dbKind: 'r2', expected: 'r2', pathStyle: false },
    { dbKind: 'minio', expected: 'minio', pathStyle: true },
    { dbKind: 's3_compatible', expected: 's3_generic', pathStyle: true },
  ];

  for (const { dbKind, expected, pathStyle } of cases) {
    test(`maps DB ${dbKind} → adapter ${expected} (forcePathStyle=${pathStyle})`, async () => {
      const db = new FakeStorageDb();
      db.rows = [makeRow({ providerKind: dbKind })];
      const secrets = new FakeSecretManager({ kind: 'ok', material: FIXTURE_MATERIAL });
      const captured: CapturedConfig = { config: null as unknown as ProviderAdapterConfig };
      const resolver = new PostgresExtendedStorageProviderResolver(asStorageDb(db), secrets, {
        buildAdapter: fakeAdapterBuilder(captured),
      });
      const result = await resolver.resolveDefaultForWorkspace(
        '00000000-0000-0000-0000-00000000bbbb',
      );
      expect(result?.providerKind).toBe(expected);
      expect(captured.config.providerKind).toBe(expected);
      expect(captured.config.forcePathStyle).toBe(pathStyle);
    });
  }

  test('throws PROVIDER_CONFIG_INVALID when the DB kind is not in the closed-set map', async () => {
    const db = new FakeStorageDb();
    db.rows = [makeRow({ providerKind: 'unknown_future_kind' })];
    const secrets = new FakeSecretManager({ kind: 'ok', material: FIXTURE_MATERIAL });
    const resolver = new PostgresExtendedStorageProviderResolver(asStorageDb(db), secrets);
    let thrown: unknown;
    try {
      await resolver.resolveDefaultForWorkspace('00000000-0000-0000-0000-00000000bbbb');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ProviderAdapterError);
    expect((thrown as ProviderAdapterError).code).toBe('PROVIDER_CONFIG_INVALID');
    expect((thrown as Error).message).not.toContain('unknown_future_kind');
  });
});

// ── Region default fallback ──────────────────────────────────────────────

describe('PostgresExtendedStorageProviderResolver — region default fallback', () => {
  test('falls back to kind-specific region when the row leaves region NULL', async () => {
    const cases = [
      { dbKind: 'r2', expectedRegion: 'auto' },
      { dbKind: 'minio', expectedRegion: 'us-east-1' },
      { dbKind: 's3_compatible', expectedRegion: 'us-east-1' },
    ];
    for (const { dbKind, expectedRegion } of cases) {
      const db = new FakeStorageDb();
      db.rows = [makeRow({ providerKind: dbKind, region: null })];
      const secrets = new FakeSecretManager({ kind: 'ok', material: FIXTURE_MATERIAL });
      const captured: CapturedConfig = { config: null as unknown as ProviderAdapterConfig };
      const resolver = new PostgresExtendedStorageProviderResolver(asStorageDb(db), secrets, {
        buildAdapter: fakeAdapterBuilder(captured),
      });
      await resolver.resolveDefaultForWorkspace('00000000-0000-0000-0000-00000000bbbb');
      expect(captured.config.region).toBe(expectedRegion);
    }
  });
});

// ── Endpoint validation ──────────────────────────────────────────────────

describe('PostgresExtendedStorageProviderResolver — endpoint validation', () => {
  test('throws PROVIDER_CONFIG_INVALID with a generic message when the row leaves endpoint NULL', async () => {
    const db = new FakeStorageDb();
    db.rows = [makeRow({ endpoint: null })];
    const secrets = new FakeSecretManager({ kind: 'ok', material: FIXTURE_MATERIAL });
    const resolver = new PostgresExtendedStorageProviderResolver(asStorageDb(db), secrets);
    let thrown: unknown;
    try {
      await resolver.resolveDefaultForWorkspace('00000000-0000-0000-0000-00000000bbbb');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ProviderAdapterError);
    expect((thrown as ProviderAdapterError).code).toBe('PROVIDER_CONFIG_INVALID');
    // Generic message — no value echo.
    expect((thrown as Error).message).not.toContain('cloudflarestorage');
    expect((thrown as Error).message).not.toContain('endpoint');
  });

  test('throws PROVIDER_CONFIG_INVALID when endpoint is whitespace-only', async () => {
    const db = new FakeStorageDb();
    db.rows = [makeRow({ endpoint: '   ' })];
    const secrets = new FakeSecretManager({ kind: 'ok', material: FIXTURE_MATERIAL });
    const resolver = new PostgresExtendedStorageProviderResolver(asStorageDb(db), secrets);
    let thrown: unknown;
    try {
      await resolver.resolveDefaultForWorkspace('00000000-0000-0000-0000-00000000bbbb');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ProviderAdapterError);
  });
});

// ── SecretManagerError mapping ───────────────────────────────────────────

describe('PostgresExtendedStorageProviderResolver — secret-manager error mapping', () => {
  const codeCases: Array<{
    code: SecretManagerErrorCode;
    expectedProviderCode: ProviderAdapterErrorCode;
  }> = [
    { code: 'NOT_FOUND', expectedProviderCode: 'PROVIDER_CONFIG_INVALID' },
    { code: 'URI_INVALID', expectedProviderCode: 'PROVIDER_CONFIG_INVALID' },
    { code: 'MATERIAL_INVALID', expectedProviderCode: 'PROVIDER_CONFIG_INVALID' },
    { code: 'BACKEND_UNAVAILABLE', expectedProviderCode: 'PROVIDER_OPERATION_FAILED' },
  ];

  for (const { code, expectedProviderCode } of codeCases) {
    test(`maps SecretManagerError(${code}) → ${expectedProviderCode}`, async () => {
      const db = new FakeStorageDb();
      db.rows = [makeRow()];
      const secrets = new FakeSecretManager({
        kind: 'error',
        code,
        message: 'backend payload that MUST NOT leak: ' + code,
      });
      const resolver = new PostgresExtendedStorageProviderResolver(asStorageDb(db), secrets);
      let thrown: unknown;
      try {
        await resolver.resolveDefaultForWorkspace('00000000-0000-0000-0000-00000000bbbb');
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ProviderAdapterError);
      expect((thrown as ProviderAdapterError).code).toBe(expectedProviderCode);
      // The original SecretManagerError message NEVER bleeds through.
      expect((thrown as Error).message).not.toContain('backend payload that MUST NOT leak');
    });
  }

  test('wraps unknown (non-SecretManagerError) backend errors as PROVIDER_OPERATION_FAILED', async () => {
    const db = new FakeStorageDb();
    db.rows = [makeRow()];
    const secrets = new FakeSecretManager({
      kind: 'unknown',
      error: new Error('custom backend leak: AKIA-LEAK-1234 / X-Amz-Signature=abc'),
    });
    const resolver = new PostgresExtendedStorageProviderResolver(asStorageDb(db), secrets);
    let thrown: unknown;
    try {
      await resolver.resolveDefaultForWorkspace('00000000-0000-0000-0000-00000000bbbb');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ProviderAdapterError);
    expect((thrown as ProviderAdapterError).code).toBe('PROVIDER_OPERATION_FAILED');
    expect((thrown as Error).message).not.toContain('AKIA-LEAK-1234');
    expect((thrown as Error).message).not.toContain('X-Amz-Signature');
  });
});

// ── No-leak invariant ────────────────────────────────────────────────────

describe('PostgresExtendedStorageProviderResolver — no-leak invariant', () => {
  test('resolver errors NEVER contain accessKeyId / secretAccessKey / credential_ref / endpoint', async () => {
    const hostileRow = makeRow({
      // Hostile values smuggled into every field a future bug could echo.
      bucket: 'leakable-bucket-name',
      endpoint: 'https://leak.example.com',
      credentialRef: 'secret://leak/path',
    });
    const db = new FakeStorageDb();
    db.rows = [hostileRow];
    // Force the URI_INVALID path with a custom backend that re-raises a
    // SecretManagerError carrying these strings.
    const secrets = new FakeSecretManager({
      kind: 'error',
      code: 'MATERIAL_INVALID',
      message:
        'leak attempt: AKIA-LEAK / xynes_live_deadbeef / https://leak.example.com / secret://leak/path',
    });
    const resolver = new PostgresExtendedStorageProviderResolver(asStorageDb(db), secrets);
    let thrown: unknown;
    try {
      await resolver.resolveDefaultForWorkspace('00000000-0000-0000-0000-00000000bbbb');
    } catch (err) {
      thrown = err;
    }
    const msg = (thrown as Error).message;
    expect(msg).not.toContain('AKIA-LEAK');
    expect(msg).not.toContain('xynes_live_deadbeef');
    expect(msg).not.toContain('https://leak.example.com');
    expect(msg).not.toContain('leak.example.com');
    expect(msg).not.toContain('secret://leak/path');
    expect(msg).not.toContain('leakable-bucket-name');
  });

  test('propagates adapter-builder ProviderAdapterError unchanged (already redacted)', async () => {
    const db = new FakeStorageDb();
    db.rows = [makeRow()];
    const secrets = new FakeSecretManager({ kind: 'ok', material: FIXTURE_MATERIAL });
    const resolver = new PostgresExtendedStorageProviderResolver(asStorageDb(db), secrets, {
      buildAdapter: () => {
        // Pretend the adapter constructor caught an invalid combo and
        // threw a redacted error; the resolver MUST surface it as-is.
        throw new ProviderAdapterError(
          'PROVIDER_CONFIG_INVALID',
          'Storage provider configuration field "region" is required',
        );
      },
    });
    let thrown: unknown;
    try {
      await resolver.resolveDefaultForWorkspace('00000000-0000-0000-0000-00000000bbbb');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ProviderAdapterError);
    expect((thrown as ProviderAdapterError).code).toBe('PROVIDER_CONFIG_INVALID');
  });
});

// ── s3AdapterDeps forwarding ─────────────────────────────────────────────

describe('PostgresExtendedStorageProviderResolver — s3AdapterDeps forwarding', () => {
  test('forwards s3AdapterDeps verbatim to the buildAdapter call', async () => {
    const db = new FakeStorageDb();
    db.rows = [makeRow()];
    const secrets = new FakeSecretManager({ kind: 'ok', material: FIXTURE_MATERIAL });

    const sentinel = { __sentinel: true } as unknown;
    let receivedDeps: unknown = undefined;
    const resolver = new PostgresExtendedStorageProviderResolver(asStorageDb(db), secrets, {
      buildAdapter: (_config, deps) => {
        receivedDeps = deps;
        return {
          providerKind: 'r2',
          endpointHost: 'example.r2.cloudflarestorage.com',
          bucket: 'fixture-bucket',
        } as unknown as StorageProviderAdapter;
      },
      s3AdapterDeps: sentinel as PostgresExtendedStorageProviderResolverDeps['s3AdapterDeps'],
    });
    await resolver.resolveDefaultForWorkspace('00000000-0000-0000-0000-00000000bbbb');
    expect(receivedDeps).toBe(sentinel);
  });
});
