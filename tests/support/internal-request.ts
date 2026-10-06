import { EventEmitter } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  internalRequestOperation,
  signInternalRequest,
} from '../../src/infra/security/internal-request';

// Inert identity fixtures: only this process owns the generated signing key.
export const gatewayIdentity = generateKeyPairSync('ed25519');
const dir = mkdtempSync(join(tmpdir(), 'sec003-request-fixture-'));
const trustFile = join(dir, 'trust.json');
writeFileSync(
  trustFile,
  JSON.stringify([
    {
      issuer: 'gateway',
      keyId: 'g1',
      publicKey: gatewayIdentity.publicKey.export({ type: 'spki', format: 'pem' }),
    },
  ]),
  { mode: 0o600 },
);
process.env.INTERNAL_REQUEST_TRUST_FILE = trustFile;

export function signedInit(path: string | URL, init: RequestInit): RequestInit {
  const url = new URL(path, 'http://localhost');
  const body = typeof init.body === 'string' ? init.body : '';
  const headers = new Headers(init.headers);
  headers.set(
    'X-Internal-Service-Token',
    signInternalRequest(
      {
        audience: 'storage-service',
        operation:
          internalRequestOperation('storage-service', url.pathname, body) || 'fixture.invalid',
        url: url.href,
        method: init.method ?? 'POST',
        headers,
        body,
      },
      { issuer: 'gateway', keyId: 'g1', privateKey: gatewayIdentity.privateKey },
    ),
  );
  return { ...init, headers };
}
EventEmitter.prototype.once.call(process, 'exit', () =>
  rmSync(dir, { recursive: true, force: true }),
);
