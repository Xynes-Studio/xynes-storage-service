/**
 * STORAGE-FU-5 — unit tests for the server-side `createS3ProviderObjectIO`.
 *
 * The shim resolves the per-call provider via the
 * `ExtendedStorageProviderResolver` (STORAGE-FU-3 contract) and bridges
 * the narrow `ProviderObjectIO` port to the adapter's
 * `getObjectBytes` / `putObjectBytes`. Tests use in-memory fake
 * resolver + fake adapter so we don't depend on Postgres or the AWS
 * SDK.
 *
 * Security invariants verified:
 *   - Missing workspaceId surfaces as `PROVIDER_IO_ROUTING_FAILED_MESSAGE`.
 *   - Resolver throws are wrapped in `PROVIDER_IO_ROUTING_FAILED_MESSAGE`
 *     so a transient secret-manager outage cannot leak its underlying
 *     error.
 *   - `null` resolution surfaces as `PROVIDER_IO_NOT_FOUND_MESSAGE`.
 *   - `providerId` routes to `resolveByProviderIdForWorkspace`; absence
 *     routes to `resolveDefaultForWorkspace`.
 *   - `ifAbsent: true` is forwarded to the adapter.
 *   - Errors NEVER carry the bucket / endpoint / accessKey.
 */
import { describe, expect, test } from 'bun:test';
import {
  createS3ProviderObjectIO,
  PROVIDER_IO_NOT_FOUND_MESSAGE,
  PROVIDER_IO_ROUTING_FAILED_MESSAGE,
} from '../../../src/infra/processors/provider-io';
import type { ExtendedStorageProviderResolver } from '../../../src/actions/handlers/objects/types';
import type {
  ResolvedProvider,
  StorageProviderResolver,
} from '../../../src/actions/handlers/uploads/types';
import { FakeStorageAdapter } from '../../actions/handlers/uploads/_fakes';

class FakeResolver implements ExtendedStorageProviderResolver, StorageProviderResolver {
  public defaultCalls = 0;
  public byIdCalls: Array<{ workspaceId: string; providerId: string }> = [];
  public defaultImpl: (workspaceId: string) => Promise<ResolvedProvider | null> = async () => null;
  public byIdImpl: (input: {
    workspaceId: string;
    providerId: string;
  }) => Promise<ResolvedProvider | null> = async () => null;
  public throwOnDefault: Error | null = null;
  public throwOnById: Error | null = null;

  async resolveDefaultForWorkspace(workspaceId: string): Promise<ResolvedProvider | null> {
    this.defaultCalls += 1;
    if (this.throwOnDefault) throw this.throwOnDefault;
    return this.defaultImpl(workspaceId);
  }

  async resolveByProviderIdForWorkspace(input: {
    workspaceId: string;
    providerId: string;
  }): Promise<ResolvedProvider | null> {
    this.byIdCalls.push(input);
    if (this.throwOnById) throw this.throwOnById;
    return this.byIdImpl(input);
  }
}

function makeResolvedProvider(overrides: Partial<ResolvedProvider> = {}): ResolvedProvider {
  return {
    providerId: '00000000-0000-4000-8000-0000000000a0',
    providerKind: 'r2',
    adapter: new FakeStorageAdapter('r2'),
    ...overrides,
  };
}

describe('createS3ProviderObjectIO — routing precondition', () => {
  test('throws PROVIDER_IO_ROUTING_FAILED_MESSAGE when workspaceId is missing on read', async () => {
    const io = createS3ProviderObjectIO({ providers: new FakeResolver() });
    await expect(io.readObject({ objectKey: 'k' })).rejects.toThrow(
      PROVIDER_IO_ROUTING_FAILED_MESSAGE,
    );
  });

  test('throws PROVIDER_IO_ROUTING_FAILED_MESSAGE when workspaceId is blank on read', async () => {
    const io = createS3ProviderObjectIO({ providers: new FakeResolver() });
    await expect(io.readObject({ objectKey: 'k', workspaceId: '' })).rejects.toThrow(
      PROVIDER_IO_ROUTING_FAILED_MESSAGE,
    );
  });

  test('throws PROVIDER_IO_ROUTING_FAILED_MESSAGE when workspaceId is missing on write', async () => {
    const io = createS3ProviderObjectIO({ providers: new FakeResolver() });
    await expect(
      io.writeObject({ objectKey: 'k', body: new Uint8Array(), contentType: 'text/plain' }),
    ).rejects.toThrow(PROVIDER_IO_ROUTING_FAILED_MESSAGE);
  });
});

describe('createS3ProviderObjectIO — resolver routing', () => {
  test('routes through resolveByProviderIdForWorkspace when providerId is supplied', async () => {
    const resolver = new FakeResolver();
    const adapter = new FakeStorageAdapter('r2');
    adapter.getObjectBytesImpl = async () => new Uint8Array([1, 2, 3]);
    resolver.byIdImpl = async () => makeResolvedProvider({ adapter });
    const io = createS3ProviderObjectIO({ providers: resolver });
    const bytes = await io.readObject({
      objectKey: 'wsA/object',
      workspaceId: 'ws-A',
      providerId: 'prov-1',
    });
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(resolver.byIdCalls).toEqual([{ workspaceId: 'ws-A', providerId: 'prov-1' }]);
    expect(resolver.defaultCalls).toBe(0);
  });

  test('routes through resolveDefaultForWorkspace when providerId is absent', async () => {
    const resolver = new FakeResolver();
    resolver.defaultImpl = async () => makeResolvedProvider();
    const io = createS3ProviderObjectIO({ providers: resolver });
    await io.readObject({ objectKey: 'k', workspaceId: 'ws-A' });
    expect(resolver.defaultCalls).toBe(1);
    expect(resolver.byIdCalls.length).toBe(0);
  });

  test('routes through resolveDefaultForWorkspace when providerId is empty string', async () => {
    const resolver = new FakeResolver();
    resolver.defaultImpl = async () => makeResolvedProvider();
    const io = createS3ProviderObjectIO({ providers: resolver });
    await io.readObject({ objectKey: 'k', workspaceId: 'ws-A', providerId: '' });
    expect(resolver.defaultCalls).toBe(1);
    expect(resolver.byIdCalls.length).toBe(0);
  });

  test('throws PROVIDER_IO_NOT_FOUND_MESSAGE when resolver returns null (default path)', async () => {
    const resolver = new FakeResolver();
    resolver.defaultImpl = async () => null;
    const io = createS3ProviderObjectIO({ providers: resolver });
    await expect(io.readObject({ objectKey: 'k', workspaceId: 'ws-A' })).rejects.toThrow(
      PROVIDER_IO_NOT_FOUND_MESSAGE,
    );
  });

  test('throws PROVIDER_IO_NOT_FOUND_MESSAGE when resolver returns null (by-id path)', async () => {
    const resolver = new FakeResolver();
    resolver.byIdImpl = async () => null;
    const io = createS3ProviderObjectIO({ providers: resolver });
    await expect(
      io.readObject({ objectKey: 'k', workspaceId: 'ws-A', providerId: 'prov-1' }),
    ).rejects.toThrow(PROVIDER_IO_NOT_FOUND_MESSAGE);
  });
});

describe('createS3ProviderObjectIO — error redaction', () => {
  test('wraps resolver throws as generic PROVIDER_IO_ROUTING_FAILED_MESSAGE (no underlying leak)', async () => {
    const resolver = new FakeResolver();
    resolver.throwOnDefault = new Error('AKIA-LEAK-1234 secret-do-not-emit');
    const io = createS3ProviderObjectIO({ providers: resolver });
    let captured: unknown;
    try {
      await io.readObject({ objectKey: 'k', workspaceId: 'ws-A' });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(Error);
    const msg = (captured as Error).message;
    expect(msg).toBe(PROVIDER_IO_ROUTING_FAILED_MESSAGE);
    expect(msg).not.toContain('AKIA');
    expect(msg).not.toContain('secret-do-not-emit');
  });

  test('wraps by-id resolver throws as generic PROVIDER_IO_ROUTING_FAILED_MESSAGE', async () => {
    const resolver = new FakeResolver();
    resolver.throwOnById = new Error('endpoint=https://leak.example/bucket');
    const io = createS3ProviderObjectIO({ providers: resolver });
    let captured: unknown;
    try {
      await io.readObject({
        objectKey: 'k',
        workspaceId: 'ws-A',
        providerId: 'prov-1',
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(Error);
    const msg = (captured as Error).message;
    expect(msg).toBe(PROVIDER_IO_ROUTING_FAILED_MESSAGE);
    expect(msg).not.toContain('endpoint');
    expect(msg).not.toContain('leak.example');
  });
});

describe('createS3ProviderObjectIO — adapter delegation', () => {
  test('readObject delegates to adapter.getObjectBytes with the requested key', async () => {
    const resolver = new FakeResolver();
    const adapter = new FakeStorageAdapter('r2');
    adapter.getObjectBytesImpl = async (opts) => new Uint8Array([opts.objectKey.length]);
    resolver.defaultImpl = async () => makeResolvedProvider({ adapter });
    const io = createS3ProviderObjectIO({ providers: resolver });
    const bytes = await io.readObject({ objectKey: 'foobar', workspaceId: 'ws-A' });
    expect(bytes).toEqual(new Uint8Array([6]));
    expect(adapter.calls).toEqual([{ method: 'getObjectBytes', opts: { objectKey: 'foobar' } }]);
  });

  test('writeObject delegates to adapter.putObjectBytes including ifAbsent=true forwarding', async () => {
    const resolver = new FakeResolver();
    const adapter = new FakeStorageAdapter('r2');
    const captured: Array<{ objectKey: string; ifAbsent?: boolean }> = [];
    adapter.putObjectBytesImpl = async (opts) => {
      captured.push({ objectKey: opts.objectKey, ifAbsent: opts.ifAbsent });
      return { byteSize: opts.body.byteLength };
    };
    resolver.defaultImpl = async () => makeResolvedProvider({ adapter });
    const io = createS3ProviderObjectIO({ providers: resolver });
    const r = await io.writeObject({
      objectKey: 'variants/preview.jpg',
      body: new Uint8Array([1, 2, 3, 4]),
      contentType: 'image/jpeg',
      ifAbsent: true,
      workspaceId: 'ws-A',
    });
    expect(r.byteSize).toBe(4);
    expect(captured.length).toBe(1);
    expect(captured[0]).toEqual({ objectKey: 'variants/preview.jpg', ifAbsent: true });
  });

  test('writeObject without ifAbsent omits the flag (defaults to undefined)', async () => {
    const resolver = new FakeResolver();
    const adapter = new FakeStorageAdapter('r2');
    let capturedIfAbsent: boolean | undefined = undefined;
    let touched = false;
    adapter.putObjectBytesImpl = async (opts) => {
      touched = true;
      capturedIfAbsent = opts.ifAbsent;
      return { byteSize: opts.body.byteLength };
    };
    resolver.defaultImpl = async () => makeResolvedProvider({ adapter });
    const io = createS3ProviderObjectIO({ providers: resolver });
    await io.writeObject({
      objectKey: 'k',
      body: new Uint8Array(),
      contentType: 'text/plain',
      workspaceId: 'ws-A',
    });
    expect(touched).toBe(true);
    expect(capturedIfAbsent).toBeUndefined();
  });
});

describe('createS3ProviderObjectIO — no-leak invariant', () => {
  test('errors NEVER include adapter / bucket / accessKey / signature substrings', async () => {
    const resolver = new FakeResolver();
    resolver.throwOnDefault = new Error(
      'AKIAFAKEKEY-leak https://s3.fake.example/bucket-leak X-Amz-Signature=DEAD',
    );
    const io = createS3ProviderObjectIO({ providers: resolver });
    let captured: unknown;
    try {
      await io.readObject({ objectKey: 'k', workspaceId: 'ws-A' });
    } catch (err) {
      captured = err;
    }
    const msg = (captured as Error).message;
    for (const needle of ['AKIA', 'bucket-leak', 'X-Amz-Signature', 'fake.example', 'leak']) {
      expect(msg).not.toContain(needle);
    }
  });
});
