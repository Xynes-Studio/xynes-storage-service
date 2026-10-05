import { describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const inReleaseImage = process.env.STORAGE_RELEASE_IMAGE_TEST === '1';

// The host suite checks the immutable build input. Artifact checks run only in
// the real Linux release image via verify-release-image.sh, never on host files.
describe.skipIf(inReleaseImage)('SEC-005 immutable base image', () => {
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

describe.skipIf(!inReleaseImage)('SEC-005 Linux production artifact', () => {
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
