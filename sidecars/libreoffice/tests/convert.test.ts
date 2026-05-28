/**
 * STORAGE-FU-5-FU-G — convert tests.
 *
 * Exercises every branch of `runConvert` against fake `FsPort` and
 * `SofficeRunner` ports — no real soffice / no real filesystem.
 *
 * Security invariants regression-guarded here:
 *
 *   1. soffice argv is NEVER user-controlled (fake spawner records
 *      the inputs and we assert the input path / output dir came from
 *      our tmpdir, not from the request).
 *   2. Per-request tmpdir is wiped in finally (cleanup is called for
 *      both success AND failure paths).
 *   3. Output Content-Type is hard-coded 'image/png' (never trust the
 *      bytes' apparent format unless the PNG magic header matches).
 *   4. Output bytes are copied — caller observes a fresh Uint8Array.
 */
import { describe, expect, test } from 'bun:test';

import {
  isPngHeader,
  parsePngDimensions,
  runConvert,
  type ConvertDeps,
  type ConvertInput,
  type FsPort,
  type SofficeRunner,
  type SofficeRunResult,
} from '../src/convert';

// ── helpers ──────────────────────────────────────────────────────────────

/** Build a syntactically-valid 4x6 PNG header (24 bytes is enough for parsePngDimensions). */
function pngBytes(width: number, height: number, totalLen = 32): Uint8Array {
  const buf = new Uint8Array(totalLen);
  // PNG magic
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  // IHDR chunk length (4 bytes BE) — not validated by parsePngDimensions
  buf.set([0x00, 0x00, 0x00, 0x0d], 8);
  // "IHDR"
  buf.set([0x49, 0x48, 0x44, 0x52], 12);
  // width @ 16, height @ 20 (big-endian)
  const view = new DataView(buf.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return buf;
}

interface FakeFsState {
  writeCalls: Array<{ path: string; data: Uint8Array }>;
  readCalls: string[];
  mkdtempCalls: string[];
  rmCalls: Array<{ path: string; options: { recursive: boolean; force: boolean } }>;
}

function makeFakeFs(
  options: {
    outputFile?: { name: string; bytes: Uint8Array };
    readFileThrows?: boolean;
    rmThrows?: boolean;
    mkdtempThrows?: boolean;
    readdirReturns?: string[];
  } = {},
): { fs: FsPort; state: FakeFsState } {
  const state: FakeFsState = {
    writeCalls: [],
    readCalls: [],
    mkdtempCalls: [],
    rmCalls: [],
  };
  const fs: FsPort = {
    async mkdtemp(prefix) {
      state.mkdtempCalls.push(prefix);
      if (options.mkdtempThrows) throw new Error('mkdtemp failed');
      return `${prefix}fake-uuid-1234`;
    },
    async writeFile(path, data) {
      state.writeCalls.push({ path, data });
    },
    async readFile(path) {
      state.readCalls.push(path);
      if (options.readFileThrows) throw new Error('read failed');
      return options.outputFile?.bytes ?? new Uint8Array();
    },
    async readdir() {
      if (options.readdirReturns) return options.readdirReturns;
      return options.outputFile ? [options.outputFile.name] : [];
    },
    async rm(path, opts) {
      state.rmCalls.push({ path, options: opts });
      if (options.rmThrows) throw new Error('rm failed');
    },
  };
  return { fs, state };
}

interface FakeRunnerState {
  calls: Array<{
    workdir: string;
    inputPath: string;
    outputDir: string;
    convertProfile: string;
    timeoutMs: number;
  }>;
}

function makeFakeRunner(
  result: SofficeRunResult | (() => Promise<SofficeRunResult>),
): { runner: SofficeRunner; state: FakeRunnerState } {
  const state: FakeRunnerState = { calls: [] };
  const runner: SofficeRunner = {
    async run(input) {
      state.calls.push(input);
      return typeof result === 'function' ? result() : result;
    },
  };
  return { runner, state };
}

function makeDeps(overrides: Partial<ConvertDeps> = {}): ConvertDeps {
  return {
    fs: makeFakeFs().fs,
    soffice: makeFakeRunner({ exitCode: 0, timedOut: false }).runner,
    tmpRoot: '/tmp',
    timeoutMs: 30_000,
    newId: () => 'fake-id',
    ...overrides,
  };
}

const PDF_INPUT: ConvertInput = {
  sourceContentType: 'application/pdf',
  bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
};

// ── happy path ─────────────────────────────────────────────────────────

describe('runConvert — happy path', () => {
  test('PDF input → PNG output with parsed dimensions', async () => {
    const outputPng = pngBytes(800, 1100);
    const { fs, state: fsState } = makeFakeFs({
      outputFile: { name: 'in.png', bytes: outputPng },
    });
    const { runner, state: runnerState } = makeFakeRunner({ exitCode: 0, timedOut: false });

    const result = await runConvert(PDF_INPUT, makeDeps({ fs, soffice: runner }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.contentType).toBe('image/png');
      expect(result.width).toBe(800);
      expect(result.height).toBe(1100);
      expect(result.bytes.byteLength).toBe(outputPng.byteLength);
      // Defense in depth: bytes are copied, not aliased.
      expect(result.bytes).not.toBe(outputPng);
    }

    // soffice argv called with our workdir, not user input.
    expect(runnerState.calls).toHaveLength(1);
    expect(runnerState.calls[0]!.inputPath).toContain('soffice-work-');
    expect(runnerState.calls[0]!.inputPath).toContain('/in.pdf');
    expect(runnerState.calls[0]!.convertProfile).toBe('png');

    // Tmpdir was wiped.
    expect(fsState.rmCalls).toHaveLength(1);
    expect(fsState.rmCalls[0]!.options).toEqual({ recursive: true, force: true });
  });

  test('DOCX input uses docx extension', async () => {
    const { runner, state } = makeFakeRunner({ exitCode: 0, timedOut: false });
    const { fs } = makeFakeFs({ outputFile: { name: 'in.png', bytes: pngBytes(800, 600) } });
    await runConvert(
      {
        sourceContentType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        bytes: new Uint8Array([0x50, 0x4b]), // ZIP magic
      },
      makeDeps({ fs, soffice: runner }),
    );
    expect(state.calls[0]!.inputPath.endsWith('/in.docx')).toBe(true);
  });

  test('null PNG dimensions on undersized header', async () => {
    // 12-byte "PNG" file — passes magic check, fails dim parse.
    const tinyPng = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    ]);
    const { fs } = makeFakeFs({ outputFile: { name: 'in.png', bytes: tinyPng } });
    const result = await runConvert(PDF_INPUT, makeDeps({ fs }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.width).toBeNull();
      expect(result.height).toBeNull();
    }
  });
});

// ── UNSUPPORTED_FORMAT defense in depth ────────────────────────────────

describe('runConvert — UNSUPPORTED_FORMAT (allowlist re-check)', () => {
  test('rejects image/png input even though FU-C filters', async () => {
    const { runner, state } = makeFakeRunner({ exitCode: 0, timedOut: false });
    const result = await runConvert(
      { sourceContentType: 'image/png', bytes: new Uint8Array([0x89]) },
      makeDeps({ soffice: runner }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('UNSUPPORTED_FORMAT');
    // soffice NEVER invoked for unsafe MIME.
    expect(state.calls).toHaveLength(0);
  });

  test('rejects empty sourceContentType', async () => {
    const result = await runConvert(
      { sourceContentType: '', bytes: new Uint8Array([0x25]) },
      makeDeps(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('UNSUPPORTED_FORMAT');
  });
});

// ── OVER_MAX_BYTES ─────────────────────────────────────────────────────

describe('runConvert — OVER_MAX_BYTES', () => {
  test('rejects payload > MAX_DOCUMENT_BYTES', async () => {
    const MAX = 100 * 1024 * 1024;
    const oversize = new Uint8Array(MAX + 1);
    const { runner, state } = makeFakeRunner({ exitCode: 0, timedOut: false });
    const result = await runConvert(
      { sourceContentType: 'application/pdf', bytes: oversize },
      makeDeps({ soffice: runner }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('OVER_MAX_BYTES');
    // soffice never invoked.
    expect(state.calls).toHaveLength(0);
  });
});

// ── TIMEOUT / CONVERT_FAILED ──────────────────────────────────────────

describe('runConvert — TIMEOUT', () => {
  test('soffice timedOut → TIMEOUT', async () => {
    const { runner } = makeFakeRunner({ exitCode: -1, timedOut: true });
    const { fs } = makeFakeFs();
    const result = await runConvert(PDF_INPUT, makeDeps({ fs, soffice: runner }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('TIMEOUT');
  });
});

describe('runConvert — CONVERT_FAILED', () => {
  test('soffice non-zero exit', async () => {
    const { runner } = makeFakeRunner({ exitCode: 1, timedOut: false });
    const { fs } = makeFakeFs();
    const result = await runConvert(PDF_INPUT, makeDeps({ fs, soffice: runner }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('CONVERT_FAILED');
  });

  test('soffice success but no .png in output dir', async () => {
    const { fs } = makeFakeFs({ readdirReturns: ['in.pdf', 'soffice.log'] });
    const result = await runConvert(PDF_INPUT, makeDeps({ fs }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('CONVERT_FAILED');
  });

  test('output PNG file is empty', async () => {
    const { fs } = makeFakeFs({ outputFile: { name: 'in.png', bytes: new Uint8Array() } });
    const result = await runConvert(PDF_INPUT, makeDeps({ fs }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('CONVERT_FAILED');
  });

  test('output bytes lack PNG magic header (defense in depth)', async () => {
    const fakeJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const { fs } = makeFakeFs({ outputFile: { name: 'in.png', bytes: fakeJpeg } });
    const result = await runConvert(PDF_INPUT, makeDeps({ fs }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('CONVERT_FAILED');
  });

  test('readFile throws → CONVERT_FAILED', async () => {
    const { fs } = makeFakeFs({
      outputFile: { name: 'in.png', bytes: pngBytes(100, 100) },
      readFileThrows: true,
    });
    const result = await runConvert(PDF_INPUT, makeDeps({ fs }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('CONVERT_FAILED');
  });

  test('mkdtemp throws → CONVERT_FAILED', async () => {
    const { fs } = makeFakeFs({ mkdtempThrows: true });
    const result = await runConvert(PDF_INPUT, makeDeps({ fs }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('CONVERT_FAILED');
  });
});

// ── cleanup invariant ─────────────────────────────────────────────────

describe('runConvert — cleanup invariant', () => {
  test('rm() is called even when soffice fails', async () => {
    const { fs, state } = makeFakeFs();
    const { runner } = makeFakeRunner({ exitCode: 99, timedOut: false });
    await runConvert(PDF_INPUT, makeDeps({ fs, soffice: runner }));
    expect(state.rmCalls).toHaveLength(1);
  });

  test('rm() is called even when readFile throws', async () => {
    const { fs, state } = makeFakeFs({
      outputFile: { name: 'in.png', bytes: pngBytes(100, 100) },
      readFileThrows: true,
    });
    await runConvert(PDF_INPUT, makeDeps({ fs }));
    expect(state.rmCalls).toHaveLength(1);
  });

  test('rm() throwing is swallowed (best-effort cleanup)', async () => {
    const { fs } = makeFakeFs({
      outputFile: { name: 'in.png', bytes: pngBytes(100, 100) },
      rmThrows: true,
    });
    // Must not throw; result must still surface (success in this case).
    const result = await runConvert(PDF_INPUT, makeDeps({ fs }));
    expect(result.ok).toBe(true);
  });
});

// ── redaction invariants ──────────────────────────────────────────────

describe('runConvert — redaction', () => {
  test('failure envelopes carry only the closed-set code (no library text)', async () => {
    const { runner } = makeFakeRunner(() =>
      Promise.reject(new Error('soffice: FATAL: cannot open /tmp/soffice-evil/in.pdf')),
    );
    const { fs } = makeFakeFs();
    const result = await runConvert(PDF_INPUT, makeDeps({ fs, soffice: runner }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // CONVERT_FAILED is the closed-set code. Any other field on
      // the envelope would be a regression.
      expect(Object.keys(result).sort()).toEqual(['code', 'ok']);
      expect(JSON.stringify(result)).not.toContain('soffice');
      expect(JSON.stringify(result)).not.toContain('/tmp/soffice-evil');
      expect(JSON.stringify(result)).not.toContain('FATAL');
    }
  });
});

// ── PNG header utilities ──────────────────────────────────────────────

describe('isPngHeader', () => {
  test('accepts the canonical magic header', () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(isPngHeader(bytes)).toBe(true);
  });

  test('rejects under-8-byte input', () => {
    expect(isPngHeader(new Uint8Array([0x89, 0x50, 0x4e]))).toBe(false);
  });

  test('rejects JPEG magic', () => {
    expect(isPngHeader(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]))).toBe(
      false,
    );
  });
});

describe('parsePngDimensions', () => {
  test('reads width + height from valid PNG IHDR', () => {
    const { width, height } = parsePngDimensions(pngBytes(1920, 1080));
    expect(width).toBe(1920);
    expect(height).toBe(1080);
  });

  test('returns nulls for under-24-byte input', () => {
    const tiny = new Uint8Array(12);
    expect(parsePngDimensions(tiny)).toEqual({ width: null, height: null });
  });

  test('returns nulls for unreasonable dimensions', () => {
    // Width = 4 billion is rejected.
    const buf = new Uint8Array(24);
    const view = new DataView(buf.buffer);
    view.setUint32(16, 0xffffffff, false);
    view.setUint32(20, 0xffffffff, false);
    expect(parsePngDimensions(buf)).toEqual({ width: null, height: null });
  });

  test('returns nulls for zero dimensions', () => {
    const buf = new Uint8Array(24);
    expect(parsePngDimensions(buf)).toEqual({ width: null, height: null });
  });
});
