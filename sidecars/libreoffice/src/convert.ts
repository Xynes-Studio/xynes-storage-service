/**
 * STORAGE-FU-5-FU-G — Pure document conversion logic.
 *
 * DI-friendly: the `runSoffice` and `fs` ports are injectable so unit
 * tests can exercise every branch without spawning a real `soffice`
 * process or touching the filesystem. Production wiring calls
 * `defaultSofficeRunner` + `defaultFs` from `shim.ts`.
 *
 * Wire contract (consumed byte-for-byte by FU-C's
 * `LibreOfficeDocumentProcessor`):
 *
 *   Request:  { sourceContentType: string, bytes: base64 string }
 *   Response: { ok: true, contentType: 'image/png', bytes: Uint8Array,
 *               width: number, height: number }
 *           | { ok: false, code: ShimErrorCode }
 *
 * Security invariants (proven by tests):
 *
 *   1. soffice argv is NEVER user-controlled. The shim builds the
 *      argv from a CLOSED-SET of safe-MIME entries — `sourceContentType`
 *      maps to a fixed `inputExtension` + fixed `convertProfile`. The
 *      input filename is `in.<ext>` (no user-controlled path).
 *   2. Per-request tmpdir under `/tmp/soffice-work-<uuid>` is wiped in
 *      `finally`. No leaked partial bytes on crash.
 *   3. Bytes flow request → in-memory base64 decode → tmpdir → soffice
 *      → tmpdir → response. NEVER over an external network. NEVER
 *      logged. NEVER reflected into error envelopes.
 *   4. soffice stderr is read but NEVER reflected — only used to pick
 *      the closed-set error code (timeout vs convert-fail).
 *   5. Output PNG dimensions are parsed from the IHDR chunk (bytes
 *      16..24 of a valid PNG). Failure to parse → null → FU-C falls
 *      back to default A4 dimensions.
 *   6. Output Content-Type is hard-coded `image/png` — the shim does
 *      NOT trust whatever soffice produced if the bytes don't look
 *      like a PNG. Defense in depth on top of FU-C's allowlist.
 */
import { SHIM_ERROR_CODES, type ShimErrorCode } from './errors';
import { MAX_DOCUMENT_BYTES, resolveSafeMime } from './safe-mime';

// ── Injectable ports ────────────────────────────────────────────────────

/**
 * Minimal subset of `node:fs/promises` we need. Re-implementing as an
 * interface (rather than typeof import('node:fs/promises')) lets the
 * shim run on Bun without dragging the full @types/node footprint into
 * the unit-test compile path.
 */
export interface FsPort {
  mkdtemp(prefix: string): Promise<string>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  readdir(path: string): Promise<string[]>;
  rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void>;
}

/**
 * Result of a soffice invocation. `code` is the OS exit code, never
 * surfaced to the caller — only inspected by the convert handler to
 * pick the closed-set error code.
 */
export interface SofficeRunResult {
  readonly exitCode: number;
  readonly timedOut: boolean;
}

/**
 * Spawner port. Production wiring uses `Bun.spawn` with a per-request
 * argv; tests inject a fake.
 */
export interface SofficeRunner {
  run(input: {
    workdir: string;
    inputPath: string;
    outputDir: string;
    convertProfile: string;
    timeoutMs: number;
  }): Promise<SofficeRunResult>;
}

// ── Pure conversion handler ──────────────────────────────────────────────

export interface ConvertSuccess {
  readonly ok: true;
  readonly contentType: 'image/png';
  readonly bytes: Uint8Array;
  readonly width: number | null;
  readonly height: number | null;
}

export interface ConvertFailure {
  readonly ok: false;
  readonly code: ShimErrorCode;
}

export type ConvertResult = ConvertSuccess | ConvertFailure;

export interface ConvertInput {
  readonly sourceContentType: string;
  readonly bytes: Uint8Array;
}

export interface ConvertDeps {
  readonly fs: FsPort;
  readonly soffice: SofficeRunner;
  readonly tmpRoot: string;
  readonly timeoutMs: number;
  /**
   * Identity generator for the per-request tmpdir suffix. Tests
   * inject a deterministic generator; production uses
   * `crypto.randomUUID()`.
   */
  readonly newId: () => string;
}

/**
 * Run a single conversion. Caller owns request parsing + status-code
 * mapping; this function is pure (modulo the injected fs / soffice
 * ports). Returns either a success envelope with the PNG bytes or a
 * closed-set failure envelope.
 *
 * Errors thrown by `fs` / `soffice` are caught and translated into
 * `CONVERT_FAILED` — raw error messages NEVER bleed through.
 */
export async function runConvert(input: ConvertInput, deps: ConvertDeps): Promise<ConvertResult> {
  // Defense-in-depth re-check: input MIME must be on the closed-set
  // allowlist. FU-C already filters, but a future direct caller (e.g.
  // an admin "force re-process" path inside the cluster) must not
  // bypass the allowlist.
  const safeMime = resolveSafeMime(input.sourceContentType);
  if (!safeMime) {
    return { ok: false, code: SHIM_ERROR_CODES.UNSUPPORTED_FORMAT };
  }

  // Defense-in-depth re-check: byte cap. FU-C also enforces.
  if (input.bytes.byteLength > MAX_DOCUMENT_BYTES) {
    return { ok: false, code: SHIM_ERROR_CODES.OVER_MAX_BYTES };
  }

  // Per-request tmpdir. Built from a fixed prefix + a UUID — NEVER
  // user input. A failure here (full disk, permission denied) is
  // handled separately from the main try/finally because we have no
  // workdir to `rm` yet.
  let workdir: string;
  try {
    workdir = await deps.fs.mkdtemp(`${deps.tmpRoot}/soffice-work-`);
  } catch {
    return { ok: false, code: SHIM_ERROR_CODES.CONVERT_FAILED };
  }

  try {
    // Input filename is `in.<ext>` — closed-set extension from
    // safe-MIME table; never user input.
    const inputPath = `${workdir}/in.${safeMime.inputExtension}`;
    await deps.fs.writeFile(inputPath, input.bytes);

    // Output dir is the same workdir; soffice writes `in.png` next
    // to the input.
    const result = await deps.soffice.run({
      workdir,
      inputPath,
      outputDir: workdir,
      convertProfile: safeMime.convertProfile,
      timeoutMs: deps.timeoutMs,
    });

    if (result.timedOut) {
      return { ok: false, code: SHIM_ERROR_CODES.TIMEOUT };
    }
    if (result.exitCode !== 0) {
      return { ok: false, code: SHIM_ERROR_CODES.CONVERT_FAILED };
    }

    // Find the output PNG. soffice names it `<input-basename>.png`,
    // but the basename can drift slightly (e.g. `in.png` vs
    // `in_in.png` on some versions) — readdir + first match on .png
    // is the safest read pattern.
    const entries = await deps.fs.readdir(workdir);
    const outputName = entries.find((name) => name.toLowerCase().endsWith('.png'));
    if (!outputName) {
      return { ok: false, code: SHIM_ERROR_CODES.CONVERT_FAILED };
    }

    const outputPath = `${workdir}/${outputName}`;
    const pngBytes = await deps.fs.readFile(outputPath);

    if (pngBytes.byteLength === 0) {
      return { ok: false, code: SHIM_ERROR_CODES.CONVERT_FAILED };
    }

    // Defense-in-depth: verify the bytes start with the PNG magic
    // header before advertising image/png. A successful exit code
    // with non-PNG bytes is treated as a soffice misbehaviour and
    // surfaced as CONVERT_FAILED.
    if (!isPngHeader(pngBytes)) {
      return { ok: false, code: SHIM_ERROR_CODES.CONVERT_FAILED };
    }

    const { width, height } = parsePngDimensions(pngBytes);

    // Copy into a fresh Uint8Array so the caller can pass the bytes
    // straight to a Response body without worrying about the
    // underlying ArrayBuffer being reused (Bun's fs reader is
    // pool-backed in some versions).
    return {
      ok: true,
      contentType: 'image/png',
      bytes: new Uint8Array(pngBytes),
      width,
      height,
    };
  } catch {
    // fs / soffice threw — convert-failed (retryable upstream). Raw
    // error text is NEVER reflected.
    return { ok: false, code: SHIM_ERROR_CODES.CONVERT_FAILED };
  } finally {
    // Always wipe the tmpdir. We swallow rm errors because tmpdir
    // wipe failure is non-fatal for THIS request — the next request
    // gets a fresh uuid; the orchestrator's tmpfs reclaims on
    // container restart.
    try {
      await deps.fs.rm(workdir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; orchestrator's tmpfs reclaims on restart.
    }
  }
}

// ── PNG header utilities ────────────────────────────────────────────────

/** First 8 bytes of every valid PNG file. */
const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function isPngHeader(bytes: Uint8Array): boolean {
  if (bytes.byteLength < PNG_MAGIC.byteLength) return false;
  for (let i = 0; i < PNG_MAGIC.byteLength; i++) {
    if (bytes[i] !== PNG_MAGIC[i]) return false;
  }
  return true;
}

/**
 * Parse the IHDR chunk of a PNG. The IHDR is fixed at offset 16, with
 * 4-byte big-endian width at offset 16 and height at offset 20.
 *
 * Returns { width: null, height: null } if the input is too short or
 * the values look unreasonable (>= 1, <= 65535 — anything larger is
 * almost certainly garbage or an attempt to confuse the caller).
 */
export function parsePngDimensions(bytes: Uint8Array): {
  width: number | null;
  height: number | null;
} {
  if (bytes.byteLength < 24) {
    return { width: null, height: null };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false); // big-endian
  const height = view.getUint32(20, false);
  // Reject obviously-bad values; FU-C will fall back to defaults.
  const safeWidth = isReasonableDim(width) ? width : null;
  const safeHeight = isReasonableDim(height) ? height : null;
  return { width: safeWidth, height: safeHeight };
}

function isReasonableDim(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= 65_535;
}
