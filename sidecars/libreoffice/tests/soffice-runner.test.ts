/**
 * STORAGE-FU-5-FU-G — soffice runner tests.
 *
 * Tests the pure argv/env builders AND the `createSofficeRunner`
 * factory against an injected fake `SpawnFn`. The real `Bun.spawn`
 * invocation lands during the Docker integration smoke (out of scope
 * for the unit suite).
 */
import { describe, expect, test } from 'bun:test';

import {
  __forTesting__,
  createSofficeRunner,
  type SpawnFn,
  type SpawnOptions,
  type SpawnedProcess,
} from '../src/soffice-runner';

// ── argv builder ────────────────────────────────────────────────────────

describe('buildSofficeArgv', () => {
  test('argv starts with `soffice` + the headless flag', () => {
    const argv = __forTesting__.buildSofficeArgv({
      inputPath: '/tmp/soffice-work-abc/in.pdf',
      outputDir: '/tmp/soffice-work-abc',
      convertProfile: 'png',
    });
    expect(argv[0]).toBe('soffice');
    expect(argv).toContain('--headless');
    expect(argv).toContain('--norestore');
    expect(argv).toContain('--nologo');
    expect(argv).toContain('--nodefault');
    expect(argv).toContain('--nofirststartwizard');
  });

  test('argv includes --convert-to <profile> + --outdir <dir>', () => {
    const argv = __forTesting__.buildSofficeArgv({
      inputPath: '/tmp/soffice-work-xyz/in.docx',
      outputDir: '/tmp/soffice-work-xyz',
      convertProfile: 'png',
    });
    const profileIdx = argv.indexOf('--convert-to');
    expect(profileIdx).toBeGreaterThan(0);
    expect(argv[profileIdx + 1]).toBe('png');
    const outdirIdx = argv.indexOf('--outdir');
    expect(outdirIdx).toBeGreaterThan(0);
    expect(argv[outdirIdx + 1]).toBe('/tmp/soffice-work-xyz');
  });

  test('argv ends with the input path', () => {
    const argv = __forTesting__.buildSofficeArgv({
      inputPath: '/tmp/soffice-work-foo/in.xlsx',
      outputDir: '/tmp/soffice-work-foo',
      convertProfile: 'png',
    });
    expect(argv[argv.length - 1]).toBe('/tmp/soffice-work-foo/in.xlsx');
  });

  test('argv carries no shell metacharacters', () => {
    const argv = __forTesting__.buildSofficeArgv({
      inputPath: '/tmp/soffice-work-bar/in.pdf',
      outputDir: '/tmp/soffice-work-bar',
      convertProfile: 'png',
    });
    for (const token of argv) {
      expect(token).not.toMatch(/[;|&`<>]|\$\(/);
    }
  });

  test('argv is structurally identical across input formats', () => {
    const pdfArgv = __forTesting__.buildSofficeArgv({
      inputPath: '/tmp/w/in.pdf',
      outputDir: '/tmp/w',
      convertProfile: 'png',
    });
    const docxArgv = __forTesting__.buildSofficeArgv({
      inputPath: '/tmp/w/in.docx',
      outputDir: '/tmp/w',
      convertProfile: 'png',
    });
    expect(pdfArgv.length).toBe(docxArgv.length);
    for (let i = 0; i < pdfArgv.length - 1; i++) {
      expect(pdfArgv[i]).toBe(docxArgv[i]);
    }
  });
});

// ── env builder ────────────────────────────────────────────────────────

describe('buildSofficeEnv', () => {
  test('sets per-process tmpdir + macro-disable flag', () => {
    const env = __forTesting__.buildSofficeEnv('/tmp/soffice-work-abc');
    expect(env.HOME).toBe('/tmp/soffice-work-abc');
    expect(env.XDG_CONFIG_HOME).toBe('/tmp/soffice-work-abc/.config');
    expect(env.XDG_CACHE_HOME).toBe('/tmp/soffice-work-abc/.cache');
    expect(env.SAL_DISABLE_MACROS).toBe('1');
    expect(env.SAL_USE_COMMON_ONE_ACCEL).toBe('0');
    expect(env.PATH.length).toBeGreaterThan(0);
  });
});

// ── createSofficeRunner — factory ───────────────────────────────────────

interface FakeProc extends SpawnedProcess {
  killCalls: string[];
}

function makeFakeSpawn(opts: { exitCode?: number; exitDelayMs?: number; neverExits?: boolean }): {
  spawn: SpawnFn;
  capture: { cmd: string[][]; options: SpawnOptions[] };
  lastProc: () => FakeProc | null;
} {
  const capture = { cmd: [] as string[][], options: [] as SpawnOptions[] };
  let lastProc: FakeProc | null = null;

  const spawn: SpawnFn = (cmd, options) => {
    capture.cmd.push(cmd);
    capture.options.push(options ?? {});

    let exitCodeInternal: number | null = null;
    let resolveExited: ((code: number) => void) | null = null;
    const exited = new Promise<number>((resolve) => {
      resolveExited = resolve;
    });
    const killCalls: string[] = [];

    if (!opts.neverExits) {
      const exit = () => {
        exitCodeInternal = opts.exitCode ?? 0;
        resolveExited?.(opts.exitCode ?? 0);
      };
      if (opts.exitDelayMs && opts.exitDelayMs > 0) {
        setTimeout(exit, opts.exitDelayMs);
      } else {
        queueMicrotask(exit);
      }
    }

    const proc: FakeProc = {
      get exitCode() {
        return exitCodeInternal;
      },
      get exited() {
        return exited;
      },
      kill(signal?: number | string): boolean {
        killCalls.push(String(signal ?? 'default'));
        if (!opts.neverExits) return true;
        // Always-running fake: kill() flips us to a terminal state.
        exitCodeInternal = 137;
        resolveExited?.(137);
        return true;
      },
      killCalls,
    };
    lastProc = proc;
    return proc;
  };
  return { spawn, capture, lastProc: () => lastProc };
}

describe('createSofficeRunner', () => {
  test('passes cwd / env / stdio to the spawn fn', async () => {
    const { spawn, capture } = makeFakeSpawn({ exitCode: 0 });
    const runner = createSofficeRunner(spawn);
    await runner.run({
      workdir: '/tmp/soffice-work-1',
      inputPath: '/tmp/soffice-work-1/in.pdf',
      outputDir: '/tmp/soffice-work-1',
      convertProfile: 'png',
      timeoutMs: 30_000,
    });
    expect(capture.cmd).toHaveLength(1);
    expect(capture.cmd[0]![0]).toBe('soffice');
    expect(capture.options[0]!.cwd).toBe('/tmp/soffice-work-1');
    expect(capture.options[0]!.stdin).toBe('ignore');
    expect(capture.options[0]!.stdout).toBe('ignore');
    expect(capture.options[0]!.stderr).toBe('ignore');
    expect(capture.options[0]!.env!.SAL_DISABLE_MACROS).toBe('1');
    expect(capture.options[0]!.env!.HOME).toBe('/tmp/soffice-work-1');
  });

  test('zero exit code → exitCode=0, timedOut=false', async () => {
    const { spawn } = makeFakeSpawn({ exitCode: 0 });
    const runner = createSofficeRunner(spawn);
    const result = await runner.run({
      workdir: '/tmp/w',
      inputPath: '/tmp/w/in.pdf',
      outputDir: '/tmp/w',
      convertProfile: 'png',
      timeoutMs: 30_000,
    });
    expect(result).toEqual({ exitCode: 0, timedOut: false });
  });

  test('non-zero exit propagates the code', async () => {
    const { spawn } = makeFakeSpawn({ exitCode: 99 });
    const runner = createSofficeRunner(spawn);
    const result = await runner.run({
      workdir: '/tmp/w',
      inputPath: '/tmp/w/in.pdf',
      outputDir: '/tmp/w',
      convertProfile: 'png',
      timeoutMs: 30_000,
    });
    expect(result.exitCode).toBe(99);
    expect(result.timedOut).toBe(false);
  });

  test('timeout fires kill() and reports timedOut=true', async () => {
    const { spawn, lastProc } = makeFakeSpawn({ neverExits: true });
    const runner = createSofficeRunner(spawn, { killGraceMs: 10 });
    const result = await runner.run({
      workdir: '/tmp/w',
      inputPath: '/tmp/w/in.pdf',
      outputDir: '/tmp/w',
      convertProfile: 'png',
      timeoutMs: 5,
    });
    expect(result.timedOut).toBe(true);
    const proc = lastProc()!;
    expect(proc.killCalls.length).toBeGreaterThanOrEqual(1);
  });

  test('kill() throwing is swallowed', async () => {
    const exited = new Promise<number>((resolve) => {
      setTimeout(() => resolve(0), 20);
    });
    const spawn: SpawnFn = () => ({
      exited,
      get exitCode() {
        return null;
      },
      kill() {
        throw new Error('kill blocked');
      },
    });
    const runner = createSofficeRunner(spawn, { killGraceMs: 5 });
    // Must NOT throw.
    const result = await runner.run({
      workdir: '/tmp/w',
      inputPath: '/tmp/w/in.pdf',
      outputDir: '/tmp/w',
      convertProfile: 'png',
      timeoutMs: 1,
    });
    expect(result.timedOut).toBe(true);
  });
});
