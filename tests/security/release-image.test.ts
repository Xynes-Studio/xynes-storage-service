import { describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { request } from 'node:http';

const inReleaseImage = process.env.STORAGE_RELEASE_IMAGE_TEST === '1';
const inEntrypointFixture = process.env.STORAGE_RELEASE_ENTRYPOINT_TEST === '1';

// The host suite checks the immutable build input. Artifact checks run only in
// the real Linux release image via verify-release-image.sh, never on host files.
describe.skipIf(inReleaseImage || inEntrypointFixture)('SEC-005 immutable base image', () => {
  test('uses a version and immutable digest for every inherited stage', async () => {
    const dockerfile = await Bun.file(new URL('../../Dockerfile', import.meta.url)).text();
    expect(dockerfile).toMatch(/^FROM oven\/bun:\d+\.\d+\.\d+@sha256:[a-f0-9]{64} AS base$/m);
    const bases = dockerfile.match(/^FROM .+$/gm) ?? [];
    expect(bases).toHaveLength(4);
    expect(bases.filter((line) => !line.endsWith(' AS base'))).toEqual([
      'FROM base AS dev',
      'FROM base AS production-dependencies',
      'FROM base AS prod',
    ]);
  });
});

describe.skipIf(!inReleaseImage || inEntrypointFixture)('SEC-005 Linux production artifact', () => {
  test('contains only the runtime manifest, source, dependencies and native assertion', () => {
    // Tests are mounted read-only by the verifier, not baked into the image.
    expect(
      readdirSync('/app')
        .filter((entry) => entry !== 'tests')
        .sort(),
    ).toEqual(['bun.lock', 'node_modules', 'package.json', 'scripts', 'src']);
    expect(readdirSync('/app/scripts')).toEqual(['assert-native-image-runtime.ts']);
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
        const path = join(directory, entry);
        const stat = lstatSync(path);
        expect(stat.isSymbolicLink()).toBe(false);
        expect(entry.startsWith('.')).toBe(false);
        if (stat.isDirectory()) visit(path);
        else expect(entry.endsWith('.ts')).toBe(true);
      }
    };
    visit('/app/src');
    expect(existsSync('/app/src/sec005-canary.txt')).toBe(false);
  });

  test('does not install development-only packages or private/build context files', () => {
    for (const name of [
      'eslint',
      'eslint-config-prettier',
      'eslint-plugin-prettier',
      'prettier',
      'drizzle-kit',
      '@typescript-eslint/parser',
      '@typescript-eslint/eslint-plugin',
      '@types/bun',
    ]) {
      expect(existsSync(join('/app/node_modules', name))).toBe(false);
    }
    for (const name of [
      '.git',
      '.env',
      '.env.dev',
      '.aws',
      '.ssh',
      '.npmrc',
      'DEVELOPER.md',
      'tsconfig.json',
      'coverage',
      'sidecars',
      'sec005-build-canary.txt',
    ]) {
      expect(existsSync(join('/app', name))).toBe(false);
    }
  });

  test('uses the dedicated bun UID and has no permitted/effective/bounding capabilities', () => {
    expect(Bun.spawnSync(['id', '-u']).stdout.toString().trim()).toBe('1000');
    expect(Bun.spawnSync(['id', '-g']).stdout.toString().trim()).toBe('1000');
    const status = readFileSync('/proc/self/status', 'utf8');
    for (const field of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) {
      expect(status).toMatch(new RegExp(`^${field}:\\s+0+$`, 'm'));
    }
    expect(status).toMatch(/^NoNewPrivs:\s+1$/m);
  });

  test('uses a read-only rootfs and bounded non-executable /tmp', () => {
    const mounts = readFileSync('/proc/mounts', 'utf8')
      .split('\n')
      .map((line) => line.split(' '));
    expect(mounts.find((row) => row[1] === '/')?.[3]?.split(',')).toContain('ro');
    const scratch = mounts.find((row) => row[1] === '/tmp');
    expect(scratch?.[2]).toBe('tmpfs');
    for (const option of ['rw', 'noexec', 'nosuid', 'size=262144k']) {
      expect(scratch?.[3]?.split(',')).toContain(option);
    }
    const write = Bun.spawnSync(['sh', '-c', 'touch /app/.sec005-write-probe']);
    expect(write.exitCode).not.toBe(0);
    const scratchWrite = Bun.spawnSync([
      'sh',
      '-c',
      'touch /tmp/sec005-scratch && rm /tmp/sec005-scratch',
    ]);
    expect(scratchWrite.exitCode).toBe(0);
  });
});

// Executes only in the verifier's owned, network-none production entrypoint
// container. The PID1 guard forbids signaling a host or arbitrary container.
function requireEntrypointFixture(): void {
  const identity = process.env.STORAGE_RELEASE_FIXTURE_NONCE;
  if (
    !inEntrypointFixture ||
    process.platform !== 'linux' ||
    process.getuid?.() !== 1001 ||
    !identity ||
    !/^[a-f0-9]{32}$/.test(identity) ||
    readFileSync('/proc/1/cmdline', 'utf8').split('\0').filter(Boolean).join(' ') !==
      'bun run src/index.ts' ||
    readFileSync('/run/secrets/fixture-nonce', 'utf8') !== identity
  ) {
    throw new Error('STORAGE_OWNED_ENTRYPOINT_FIXTURE_REQUIRED');
  }
}
async function entrypointHealth(): Promise<void> {
  requireEntrypointFixture();
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch('http://127.0.0.1:4204/health', {
        signal: AbortSignal.timeout(1000),
      });
      const body = (await response.json()) as { ok?: unknown; service?: unknown };
      if (response.status === 200 && body.ok === true && body.service === 'storage-service') return;
    } catch {
      // The real entrypoint may still be starting; keep the wait bounded.
    }
    await Bun.sleep(200);
  }
  throw new Error('STORAGE_RELEASE_ENTRYPOINT_HEALTH_FAILED');
}
function entrypointStatus(
  token: string,
): Promise<{ status: number; state?: string; admission_open?: boolean }> {
  requireEntrypointFixture();
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ owner: 'a'.repeat(32) });
    const req = request(
      {
        socketPath: '/run/xynes/storage-control/control.sock',
        method: 'POST',
        path: '/status',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          raw += chunk;
          if (Buffer.byteLength(raw) > 4096)
            req.destroy(new Error('STORAGE_CONTROL_RESPONSE_REFUSED'));
        });
        res.on('error', () => {
          clearTimeout(timer);
          reject(new Error('STORAGE_CONTROL_RESPONSE_REFUSED'));
        });
        res.on('end', () => {
          clearTimeout(timer);
          try {
            const value = JSON.parse(raw) as { state?: string; admission_open?: boolean };
            resolve({
              status: res.statusCode!,
              state: value.state,
              admission_open: value.admission_open,
            });
          } catch {
            reject(new Error('STORAGE_CONTROL_RESPONSE_REFUSED'));
          }
        });
      },
    );
    const timer = setTimeout(
      () => req.destroy(new Error('STORAGE_CONTROL_RESPONSE_REFUSED')),
      2000,
    );
    req.on('error', () => {
      clearTimeout(timer);
      reject(new Error('STORAGE_CONTROL_RESPONSE_REFUSED'));
    });
    req.end(body);
  });
}
describe.skipIf(!inEntrypointFixture)('SEC-005 production hosted control fixture', () => {
  test('uses owned UID1001 private control and readonly token assets', async () => {
    await entrypointHealth();
    requireEntrypointFixture();
    const directory = lstatSync('/run/xynes/storage-control');
    const tokenFile = lstatSync('/run/secrets/storage-quiesce-token');
    const socket = lstatSync('/run/xynes/storage-control/control.sock');
    expect(directory.uid).toBe(1001);
    expect(directory.mode & 0o777).toBe(0o700);
    expect(tokenFile.uid).toBe(1001);
    expect(tokenFile.mode & 0o777).toBe(0o400);
    expect(tokenFile.nlink).toBe(1);
    expect(socket.uid).toBe(1001);
    expect(socket.isSocket()).toBe(true);
    expect(socket.mode & 0o777).toBe(0o600);
    expect(/^[a-f0-9]{64}$/.test(readFileSync('/run/secrets/storage-quiesce-token', 'utf8'))).toBe(
      true,
    );
    const mounts = readFileSync('/proc/mounts', 'utf8')
      .split('\n')
      .map((line) => line.split(' '));
    expect(mounts.find((row) => row[1] === '/run/secrets')?.[3]?.split(',')).toContain('ro');
    expect(process.env.NODE_ENV).toBe('production');
    expect(process.env.STORAGE_QUIESCENCE_ENABLED).toBe('1');
  });
  test('real default entrypoint serves bounded loopback health and authenticated private status', async () => {
    await entrypointHealth();
    const token = readFileSync('/run/secrets/storage-quiesce-token', 'utf8');
    expect(await entrypointStatus(token)).toEqual({
      status: 200,
      state: 'open',
      admission_open: true,
    });
    const invalid = (token[0] === '0' ? '1' : '0') + token.slice(1);
    expect((await entrypointStatus(invalid)).status).toBe(403);
    expect((await entrypointStatus(token)).admission_open).toBe(true);
  }, 10000);
  test('actual unqualified SIGTERM leaves owned PID1 and hosted admission alive', async () => {
    await entrypointHealth();
    requireEntrypointFixture();
    process.kill(1, 'SIGTERM');
    await Bun.sleep(250);
    await entrypointHealth();
    const token = readFileSync('/run/secrets/storage-quiesce-token', 'utf8');
    expect(await entrypointStatus(token)).toEqual({
      status: 200,
      state: 'open',
      admission_open: true,
    });
  }, 10000);
});
