/**
 * STORAGE-FU-3 — integration tests for `PostgresExtendedStorageProviderResolver`.
 *
 * Runs against a real Postgres (dev Supabase by default; ephemeral
 * container in CI via `STORAGE_INTEGRATION_DB_URL`). Tests soft-skip
 * when the DB is unreachable so a clean laptop still passes `bun test`.
 *
 * Workspace isolation:
 *   - `resolveDefaultForWorkspace` returns the workspace's own default
 *     row, never a row belonging to a different workspace.
 *   - `resolveByProviderIdForWorkspace` returns null when the provider
 *     id exists in a DIFFERENT workspace.
 *   - `status = 'disabled'` rows are filtered out.
 *
 * The test seeds its own workspace + user + provider fixtures via the
 * shared `_db.ts` helper, then relies on the `ON DELETE CASCADE` on
 * `workspace_id` to tear them down.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { PostgresExtendedStorageProviderResolver } from '../../../../src/infra/db/repositories/provider-resolver';
import {
  EnvSecretManagerClient,
  type ProviderCredentialMaterial,
  type SecretManagerClient,
} from '../../../../src/infra/providers/secret-manager';
import type {
  ProviderAdapterConfig,
  StorageProviderAdapter,
} from '../../../../src/infra/providers';
import { connectOrSkip, seedWorkspaceFixture, type IntegrationDb } from './_db';

/** Build a fake adapter so the integration tests never hit the network. */
function fakeAdapterBuilder(captures: ProviderAdapterConfig[] = []) {
  return (config: ProviderAdapterConfig): StorageProviderAdapter => {
    captures.push(config);
    return {
      providerKind: config.providerKind,
      endpointHost: new URL(config.endpoint).host,
      bucket: config.bucket,
    } as unknown as StorageProviderAdapter;
  };
}

/** Test-double secret manager that returns deterministic material. */
const fixedSecrets: SecretManagerClient = {
  async resolve(_credentialRef: string): Promise<ProviderCredentialMaterial> {
    return {
      accessKeyId: 'INTEGRATION-FIXTURE-ACCESS',
      secretAccessKey: 'integration-fixture-secret-DO-NOT-LEAK',
    };
  },
};

const ctx: { current: IntegrationDb | null } = { current: null };

beforeAll(async () => {
  ctx.current = await connectOrSkip();
  if (!ctx.current) {
    // eslint-disable-next-line no-console
    console.warn('[STORAGE-FU-3] DB unreachable; skipping provider-resolver integration tests.');
  }
});

afterAll(async () => {
  await ctx.current?.handle.close();
});

function describeIf(label: string, fn: () => void): void {
  describe(label, () => {
    test('precondition: DB reachable', () => {
      if (!ctx.current) {
        expect(ctx.current).toBeNull();
        return;
      }
      expect(ctx.current).not.toBeNull();
    });
    fn();
  });
}

describeIf('PostgresExtendedStorageProviderResolver (integration)', () => {
  test('resolveDefaultForWorkspace returns the workspace default row', async () => {
    if (!ctx.current) return;
    const fixture = await seedWorkspaceFixture(ctx.current.db);
    try {
      const resolver = new PostgresExtendedStorageProviderResolver(ctx.current.db, fixedSecrets, {
        buildAdapter: fakeAdapterBuilder(),
      });
      const result = await resolver.resolveDefaultForWorkspace(fixture.workspaceId);
      expect(result).not.toBeNull();
      expect(result?.providerId).toBe(fixture.providerId);
      expect(result?.providerKind).toBe('r2');
    } finally {
      await fixture.cleanup();
    }
  });

  test('resolveDefaultForWorkspace returns null when there is no default row', async () => {
    if (!ctx.current) return;
    const fixture = await seedWorkspaceFixture(ctx.current.db);
    try {
      await ctx.current.db.execute(sql`
        UPDATE platform.workspace_storage_providers
           SET is_default = false
         WHERE id = ${fixture.providerId}
      `);
      const resolver = new PostgresExtendedStorageProviderResolver(ctx.current.db, fixedSecrets, {
        buildAdapter: fakeAdapterBuilder(),
      });
      const result = await resolver.resolveDefaultForWorkspace(fixture.workspaceId);
      expect(result).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });

  test('resolveDefaultForWorkspace filters out disabled rows', async () => {
    if (!ctx.current) return;
    const fixture = await seedWorkspaceFixture(ctx.current.db);
    try {
      await ctx.current.db.execute(sql`
        UPDATE platform.workspace_storage_providers
           SET status = 'disabled'
         WHERE id = ${fixture.providerId}
      `);
      const resolver = new PostgresExtendedStorageProviderResolver(ctx.current.db, fixedSecrets, {
        buildAdapter: fakeAdapterBuilder(),
      });
      const result = await resolver.resolveDefaultForWorkspace(fixture.workspaceId);
      expect(result).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });

  test('resolveDefaultForWorkspace does NOT cross workspace boundaries', async () => {
    if (!ctx.current) return;
    const wsA = await seedWorkspaceFixture(ctx.current.db);
    const wsB = await seedWorkspaceFixture(ctx.current.db);
    try {
      const resolver = new PostgresExtendedStorageProviderResolver(ctx.current.db, fixedSecrets, {
        buildAdapter: fakeAdapterBuilder(),
      });
      const fromA = await resolver.resolveDefaultForWorkspace(wsA.workspaceId);
      const fromB = await resolver.resolveDefaultForWorkspace(wsB.workspaceId);
      expect(fromA?.providerId).toBe(wsA.providerId);
      expect(fromB?.providerId).toBe(wsB.providerId);
      expect(fromA?.providerId).not.toBe(fromB?.providerId);
    } finally {
      await wsA.cleanup();
      await wsB.cleanup();
    }
  });

  test('resolveDefaultForWorkspace returns null for a workspace with NO provider row', async () => {
    if (!ctx.current) return;
    const orphanWorkspaceId = randomUUID();
    const resolver = new PostgresExtendedStorageProviderResolver(ctx.current.db, fixedSecrets, {
      buildAdapter: fakeAdapterBuilder(),
    });
    const result = await resolver.resolveDefaultForWorkspace(orphanWorkspaceId);
    expect(result).toBeNull();
  });

  test('resolveByProviderIdForWorkspace returns null when providerId exists in a DIFFERENT workspace (no enumeration oracle)', async () => {
    if (!ctx.current) return;
    const wsA = await seedWorkspaceFixture(ctx.current.db);
    const wsB = await seedWorkspaceFixture(ctx.current.db);
    try {
      const resolver = new PostgresExtendedStorageProviderResolver(ctx.current.db, fixedSecrets, {
        buildAdapter: fakeAdapterBuilder(),
      });
      const result = await resolver.resolveByProviderIdForWorkspace({
        workspaceId: wsB.workspaceId,
        providerId: wsA.providerId,
      });
      expect(result).toBeNull();
    } finally {
      await wsA.cleanup();
      await wsB.cleanup();
    }
  });

  test('resolveByProviderIdForWorkspace returns the row when the workspace matches', async () => {
    if (!ctx.current) return;
    const fixture = await seedWorkspaceFixture(ctx.current.db);
    try {
      const resolver = new PostgresExtendedStorageProviderResolver(ctx.current.db, fixedSecrets, {
        buildAdapter: fakeAdapterBuilder(),
      });
      const result = await resolver.resolveByProviderIdForWorkspace({
        workspaceId: fixture.workspaceId,
        providerId: fixture.providerId,
      });
      expect(result).not.toBeNull();
      expect(result?.providerId).toBe(fixture.providerId);
    } finally {
      await fixture.cleanup();
    }
  });

  test('resolveByProviderIdForWorkspace filters out disabled rows', async () => {
    if (!ctx.current) return;
    const fixture = await seedWorkspaceFixture(ctx.current.db);
    try {
      await ctx.current.db.execute(sql`
        UPDATE platform.workspace_storage_providers
           SET status = 'disabled'
         WHERE id = ${fixture.providerId}
      `);
      const resolver = new PostgresExtendedStorageProviderResolver(ctx.current.db, fixedSecrets, {
        buildAdapter: fakeAdapterBuilder(),
      });
      const result = await resolver.resolveByProviderIdForWorkspace({
        workspaceId: fixture.workspaceId,
        providerId: fixture.providerId,
      });
      expect(result).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });

  test('resolveDefaultForWorkspace + EnvSecretManagerClient end-to-end', async () => {
    if (!ctx.current) return;
    const fixture = await seedWorkspaceFixture(ctx.current.db);
    try {
      // Seed fixture uses `secret://storage-fu2/r2` so the env-prefix is
      // `STORAGE_CREDENTIAL_STORAGE_FU2_R2_*`.
      const envClient = new EnvSecretManagerClient({
        env: {
          STORAGE_CREDENTIAL_STORAGE_FU2_R2_ACCESS_KEY_ID: 'AKIA-FIXTURE-INTEGRATION',
          STORAGE_CREDENTIAL_STORAGE_FU2_R2_SECRET_ACCESS_KEY: 'fixture-secret-integration',
        },
      });
      const captures: ProviderAdapterConfig[] = [];
      const resolver = new PostgresExtendedStorageProviderResolver(ctx.current.db, envClient, {
        buildAdapter: fakeAdapterBuilder(captures),
      });
      const result = await resolver.resolveDefaultForWorkspace(fixture.workspaceId);
      expect(result).not.toBeNull();
      expect(captures[0]?.accessKeyId).toBe('AKIA-FIXTURE-INTEGRATION');
      expect(captures[0]?.secretAccessKey).toBe('fixture-secret-integration');
    } finally {
      await fixture.cleanup();
    }
  });
});
