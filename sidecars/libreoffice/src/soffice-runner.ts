/**
 * STORAGE-FU-5-FU-G — Production soffice spawner.
 *
 * Wraps `Bun.spawn` to invoke `soffice --headless --convert-to <profile>
 * --outdir <outputDir> <inputPath>` per request. NO daemon mode — the
 * documented memory-leak mitigation from plan §12.5 risk register.
 *
 * The spawner enforces a hard timeout. A runaway conversion is killed
 * via `proc.kill()` (SIGTERM by default; we add a SIGKILL fallback if
 * the process refuses to exit). The killed conversion surfaces as a
 * `timedOut: true` result; the convert handler maps that to TIMEOUT
 * (504), which FU-C in turn maps to retryable `PROCESSOR_FAILED`.
 *
 * Stderr is consumed but NEVER reflected — defense in depth on top of
 * FU-C's redaction.
 *
 * Spawning is exposed via an injectable `SpawnFn` so unit tests can
 * exercise the env + argv + timeout/kill branches without a real
 * `soffice` binary. The default production wiring passes `Bun.spawn`.
 */
import type { SofficeRunResult, SofficeRunner } from './convert';

// ── Spawn port ──────────────────────────────────────────────────────────

/**
 * Minimal subset of `Bun.spawn`'s return type we need.
 */
export interface SpawnedProcess {
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  kill(signal?: number | string): boolean;
}

export interface SpawnOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly stdin?: 'pipe' | 'inherit' | 'ignore' | null;
  readonly stdout?: 'pipe' | 'inherit' | 'ignore' | null;
  readonly stderr?: 'pipe' | 'inherit' | 'ignore' | null;
}

export type SpawnFn = (cmd: string[], options?: SpawnOptions) => SpawnedProcess;

// ── argv + env builders (pure) ──────────────────────────────────────────

/**
 * The soffice argv. CLOSED — every component comes from a fixed
 * source (the safe-MIME table or a per-request UUID-named path). NO
 * user input reaches the argv.
 */
function buildSofficeArgv(input: {
  inputPath: string;
  outputDir: string;
  convertProfile: string;
}): string[] {
  return [
    'soffice',
    '--headless',
    '--norestore',
    '--nologo',
    '--nodefault',
    '--nofirststartwizard',
    '--convert-to',
    input.convertProfile,
    '--outdir',
    input.outputDir,
    input.inputPath,
  ];
}

/** Per-process env. Closed-set + image-baked invariant (SAL_DISABLE_MACROS=1). */
function buildSofficeEnv(workdir: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: workdir,
    XDG_CONFIG_HOME: `${workdir}/.config`,
    XDG_CACHE_HOME: `${workdir}/.cache`,
    SAL_DISABLE_MACROS: '1',
    SAL_USE_COMMON_ONE_ACCEL: '0',
  };
}

// ── factory ─────────────────────────────────────────────────────────────

export interface CreateSofficeRunnerOptions {
  readonly killGraceMs?: number;
  readonly setTimeoutFn?: typeof setTimeout;
  readonly clearTimeoutFn?: typeof clearTimeout;
}

/**
 * Build a `SofficeRunner` backed by the injected `spawn` function.
 */
export function createSofficeRunner(
  spawn: SpawnFn,
  options: CreateSofficeRunnerOptions = {},
): SofficeRunner {
  const killGraceMs = options.killGraceMs ?? 2_000;
  const setTimeoutImpl = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutImpl = options.clearTimeoutFn ?? clearTimeout;

  return {
    async run(input): Promise<SofficeRunResult> {
      const argv = buildSofficeArgv({
        inputPath: input.inputPath,
        outputDir: input.outputDir,
        convertProfile: input.convertProfile,
      });

      const proc = spawn(argv, {
        cwd: input.workdir,
        env: buildSofficeEnv(input.workdir),
        // Bytes flow: stdin unused (soffice reads the input file from
        // disk); stdout unused (soffice writes the PNG file to
        // --outdir, NOT to stdout); stderr deliberately discarded so
        // (a) a chatty soffice can't deadlock by filling the pipe
        // buffer with no reader, and (b) stderr text NEVER reaches
        // any code path that could reflect it. Closed-set runner
        // errors are decided from exit code + timeout flag only.
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      });

      let timedOut = false;
      let sigkillTimer: ReturnType<typeof setTimeout> | null = null;
      const killTimer = setTimeoutImpl(() => {
        timedOut = true;
        try {
          proc.kill();
        } catch {
          // Already-exited proc.
        }
        sigkillTimer = setTimeoutImpl(() => {
          if (proc.exitCode === null) {
            try {
              proc.kill('SIGKILL');
            } catch {
              // Already-exited proc.
            }
          }
        }, killGraceMs);
      }, input.timeoutMs);

      let exitCode: number;
      try {
        exitCode = await proc.exited;
      } finally {
        clearTimeoutImpl(killTimer);
        if (sigkillTimer) clearTimeoutImpl(sigkillTimer);
      }

      return { exitCode, timedOut };
    },
  };
}

/**
 * Default soffice runner — uses the global `Bun.spawn`. Production
 * wiring constructs this once at boot in `shim.ts`.
 *
 * Bun's own `spawn` typings expose multiple overloads; we project
 * onto our narrower `SpawnFn` shape via an `unknown` cast because the
 * runtime call shape `Bun.spawn(["cmd", ...args], options)` IS
 * supported, but the strict typings from `bun-types` don't expose
 * that overload cleanly.
 */
export const defaultSofficeRunner: SofficeRunner = createSofficeRunner((cmd, opts) => {
  const globalBun = (globalThis as unknown as { Bun?: { spawn: unknown } }).Bun;
  if (!globalBun) {
    throw new Error('Bun.spawn is required at runtime; pass options.soffice in tests.');
  }
  const spawnImpl = globalBun.spawn as unknown as SpawnFn;
  return spawnImpl(cmd, opts);
});

// ── test-only seam ──────────────────────────────────────────────────────

export const __forTesting__ = {
  buildSofficeArgv,
  buildSofficeEnv,
};
