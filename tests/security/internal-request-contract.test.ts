// Generated from platform-contracts internal-request-core.test.ts; update the canonical suite and re-export.
import { z } from 'zod';
import { describe, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import {
  signInternalRequest,
  verifyInternalRequest,
} from '../../src/infra/security/internal-request';

const gateway = generateKeyPairSync('ed25519');
const accounts = generateKeyPairSync('ed25519');
const sibling = generateKeyPairSync('ed25519');
const keys = [
  { issuer: 'gateway', keyId: 'g1', publicKey: gateway.publicKey },
  { issuer: 'accounts', keyId: 'a1', publicKey: accounts.publicKey },
  { issuer: 'cms', keyId: 'c1', publicKey: sibling.publicKey },
];
function fixture(issuer = 'accounts', operation = 'authz.assignRole') {
  const headers = new Headers({
    'X-Request-Id': 'r1',
    'X-Workspace-Id': 'tenant-a',
    'X-XS-User-Id': 'actor-a',
  });
  const body = JSON.stringify({
    actionKey: operation,
    payload: { workspaceId: 'tenant-a', userId: 'target', roleKey: 'workspace_owner' },
  });
  const request = {
    audience: 'authz-service',
    operation,
    url: 'http://authz/internal/authz-actions',
    method: 'POST',
    headers,
    body,
  };
  const privateKey =
    issuer === 'gateway'
      ? gateway.privateKey
      : issuer === 'accounts'
        ? accounts.privateKey
        : sibling.privateKey;
  const keyId = issuer === 'gateway' ? 'g1' : issuer === 'accounts' ? 'a1' : 'c1';
  const token = signInternalRequest(request, { issuer, keyId, privateKey }, 100);
  return { request, token };
}
describe('SEC-003 bound requests', () => {
  it('accepts accounts role assignment', () => {
    const { request, token } = fixture();
    expect(verifyInternalRequest(token, request, keys, 101)).toBe(true);
  });
  it('denies sibling lateral movement and gateway assignment', () => {
    for (const issuer of ['cms', 'gateway']) {
      const { request, token } = fixture(issuer);
      expect(verifyInternalRequest(token, request, keys, 101)).toBe(false);
    }
  });
  it('denies wrong key, audience, action, method, path, body and expired tokens', () => {
    const { request, token } = fixture();
    expect(verifyInternalRequest(token, request, [], 101)).toBe(false);
    for (const change of [
      { audience: 'accounts-service' },
      { operation: 'authz.listRolesForWorkspace' },
      { method: 'GET' },
      { url: 'http://authz/authz/check' },
      { body: request.body + ' ' },
    ]) {
      expect(verifyInternalRequest(token, { ...request, ...change }, keys, 101)).toBe(false);
    }
    expect(verifyInternalRequest(token, request, keys, 160)).toBe(false);
    expect(verifyInternalRequest(token, request, keys, 99)).toBe(false);
    expect(verifyInternalRequest('legacy', request, keys, 101)).toBe(false);
    expect(verifyInternalRequest('a.b.c', request, keys, 101)).toBe(false);
  });
  it('denies changing workspace, actor metadata, API key or request id', () => {
    const { request, token } = fixture();
    for (const name of [
      'X-Workspace-Id',
      'X-XS-User-Id',
      'X-XS-User-Email',
      'X-XS-User-Name',
      'X-XS-User-Avatar-Url',
      'X-XS-Actor-Type',
      'X-XS-API-Key-Id',
      'X-XS-API-Key-Prefix',
      'X-Request-Id',
    ]) {
      const headers = new Headers(request.headers);
      headers.set(name, 'tenant-b');
      expect(verifyInternalRequest(token, { ...request, headers }, keys, 101)).toBe(false);
    }
  });
  it('binds workspace in authz payload even when correctly signed', () => {
    const { request } = fixture();
    const changed = { ...request, body: request.body.replace('tenant-a', 'tenant-b') };
    const token = signInternalRequest(
      changed,
      { issuer: 'accounts', keyId: 'a1', privateKey: accounts.privateKey },
      100,
    );
    expect(verifyInternalRequest(token, changed, keys, 101)).toBe(false);
  });
});

import { createHmac, sign } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadInternalRequestSigner,
  loadInternalRequestTrust,
  readInternalRequestBody,
  internalRequestOperation,
} from '../../src/infra/security/internal-request';

describe('SEC-003 key configuration and parser', () => {
  it('loads private signing files/public trust sets and rejects invalid/duplicate key material', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sec003-config-'));
    const saved = {
      private: process.env.INTERNAL_REQUEST_PRIVATE_KEY_FILE,
      kid: process.env.INTERNAL_REQUEST_KEY_ID,
      trust: process.env.INTERNAL_REQUEST_TRUST_FILE,
    };
    try {
      const privateFile = join(dir, 'private');
      const trustFile = join(dir, 'trust');
      process.env.INTERNAL_REQUEST_PRIVATE_KEY_FILE = privateFile;
      process.env.INTERNAL_REQUEST_KEY_ID = 'g1';
      process.env.INTERNAL_REQUEST_TRUST_FILE = trustFile;
      expect(() => loadInternalRequestSigner('gateway')).toThrow('misconfigured');
      expect(() => loadInternalRequestTrust()).toThrow('misconfigured');
      writeFileSync(privateFile, gateway.privateKey.export({ type: 'pkcs8', format: 'pem' }));
      expect(loadInternalRequestSigner('gateway').privateKey.asymmetricKeyType).toBe('ed25519');
      const publicEntry = {
        issuer: 'gateway',
        keyId: 'g1',
        publicKey: gateway.publicKey.export({ type: 'spki', format: 'pem' }),
      };
      writeFileSync(trustFile, JSON.stringify([publicEntry]));
      expect(loadInternalRequestTrust()).toHaveLength(1);
      for (const entries of [
        [],
        [publicEntry, publicEntry],
        [
          {
            ...publicEntry,
            publicKey: gateway.privateKey.export({ type: 'pkcs8', format: 'pem' }),
          },
        ],
        [{ ...publicEntry, publicKey: '-----BEGIN PUBLIC KEY-----bad' }],
      ]) {
        writeFileSync(trustFile, JSON.stringify(entries));
        expect(() => loadInternalRequestTrust()).toThrow('misconfigured');
      }
      const wrong = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      writeFileSync(privateFile, wrong.privateKey.export({ type: 'pkcs8', format: 'pem' }));
      expect(() => loadInternalRequestSigner('gateway')).toThrow('misconfigured');
      writeFileSync(
        trustFile,
        JSON.stringify([
          { ...publicEntry, publicKey: wrong.publicKey.export({ type: 'spki', format: 'pem' }) },
        ]),
      );
      expect(() => loadInternalRequestTrust()).toThrow('misconfigured');
      delete process.env.INTERNAL_REQUEST_PRIVATE_KEY_FILE;
      delete process.env.INTERNAL_REQUEST_TRUST_FILE;
      expect(() => loadInternalRequestSigner('accounts')).toThrow('misconfigured');
      expect(() => loadInternalRequestTrust()).toThrow('misconfigured');
    } finally {
      if (saved.private === undefined) delete process.env.INTERNAL_REQUEST_PRIVATE_KEY_FILE;
      else process.env.INTERNAL_REQUEST_PRIVATE_KEY_FILE = saved.private;
      if (saved.kid === undefined) delete process.env.INTERNAL_REQUEST_KEY_ID;
      else process.env.INTERNAL_REQUEST_KEY_ID = saved.kid;
      if (saved.trust === undefined) delete process.env.INTERNAL_REQUEST_TRUST_FILE;
      else process.env.INTERNAL_REQUEST_TRUST_FILE = saved.trust;
      rmSync(dir, { recursive: true });
    }
  });
  it('bounds actual streamed bytes, missing bodies and invalid limits', async () => {
    expect((await readInternalRequestBody(new Request('http://x'), 10)).length).toBe(0);
    expect(
      Buffer.from(
        await readInternalRequestBody(new Request('http://x', { method: 'POST', body: 'abc' }), 3),
      ).toString(),
    ).toBe('abc');
    await expect(
      readInternalRequestBody(
        new Request('http://x', {
          method: 'POST',
          body: 'abcd',
          headers: { 'Content-Length': '1' },
        }),
        3,
      ),
    ).rejects.toThrow('too large');
    await expect(readInternalRequestBody(new Request('http://x'), 0)).rejects.toThrow('too large');
    expect(internalRequestOperation('authz-service', '/authz/check', '{}')).toBe('authz.check');
    expect(internalRequestOperation('accounts-service', '/internal/accounts-actions', '{}')).toBe(
      '',
    );
    expect(internalRequestOperation('accounts-service', '/internal/accounts-actions', '{')).toBe(
      '',
    );
    expect(
      internalRequestOperation(
        'accounts-service',
        '/internal/accounts-actions',
        new TextEncoder().encode('{"actionKey":"accounts.ping"}'),
      ),
    ).toBe('accounts.ping');
  });
  it('rejects algorithm/type confusion, malformed claims, signature mutation and excessive TTL', () => {
    const { request, token } = fixture();
    const [head, payload] = token.split('.');
    const originalHeader = z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(Buffer.from(head ?? '', 'base64url').toString()));
    const originalClaims = z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(Buffer.from(payload ?? '', 'base64url').toString()));
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    for (const header of [
      { ...originalHeader, alg: 'none' },
      { ...originalHeader, alg: 'HS256' },
      { ...originalHeader, typ: 'JWT' },
      { ...originalHeader, kid: 'unknown' },
    ]) {
      const input = `${encode(header)}.${payload}`;
      const malicious = `${input}.${createHmac('sha256', 'shared-sibling-key').update(input).digest('base64url')}`;
      expect(verifyInternalRequest(malicious, request, keys, 101)).toBe(false);
    }
    for (const claims of [
      { ...originalClaims, exp: 200 },
      { ...originalClaims, exp: 100 },
      { ...originalClaims, iat: 102 },
      { ...originalClaims, iss: 'gateway' },
      { ...originalClaims, context: [] },
    ]) {
      const input = `${head}.${encode(claims)}`;
      const malicious = `${input}.${sign(null, Buffer.from(input), accounts.privateKey).toString('base64url')}`;
      expect(verifyInternalRequest(malicious, request, keys, 101)).toBe(false);
    }
    expect(
      verifyInternalRequest(token.slice(0, -20) + 'aaaaaaaaaaaaaaaaaaaa', request, keys, 101),
    ).toBe(false);
    expect(verifyInternalRequest('a'.repeat(16385), request, keys, 101)).toBe(false);
  });
});
