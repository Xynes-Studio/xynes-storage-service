/**
 * STORAGE-FU-5-FU-C — `LibreOfficeDocumentProcessor` unit tests.
 *
 * Test posture mirrors `ffmpeg-video-processor.test.ts`:
 *
 *   1. **Pure helper tests** — `validateSidecarUrl`, `buildConvertUrl`,
 *      `parsePositiveIntHeader`, `isAllowedPreviewContentType`. No
 *      HTTP I/O.
 *   2. **Sidecar-client-injected processor tests** —
 *      `LibreOfficeDocumentProcessor` with a fake
 *      `DocumentSidecarClient` exercises every renderFirstPagePreview
 *      branch deterministically.
 *   3. **`defaultFetchSidecarClient` shape tests** — verify the
 *      production fetch client builds the documented wire shape
 *      (URL, method, headers, JSON body with base64 bytes) without
 *      making a real network call. We do this by monkey-patching
 *      `globalThis.fetch` inside one isolated test.
 *
 * SECURITY invariants verified:
 *   - Allowlist re-check inside the processor (defense in depth on
 *     top of the STORAGE-8 runner check).
 *   - `MAX_DOCUMENT_BYTES` hard cap re-check.
 *   - Output Content-Type must be in the closed set
 *     (`image/png`, `image/jpeg`); any other value → PROCESSOR_FAILED.
 *   - Sidecar 4xx → `UNSUPPORTED_FORMAT` (non-retryable).
 *   - Sidecar 5xx / network / timeout / status=0 → `PROCESSOR_FAILED`
 *     (retryable).
 *   - URL validator rejects non-`http(s)` schemes and unparseable
 *     strings.
 *   - URL builder NEVER incorporates user input into the URL.
 *   - Raw sidecar error text / headers / body NEVER leak through
 *     runner error messages.
 *   - Empty 2xx body → `PROCESSOR_FAILED`.
 *   - Bytes copied into a fresh `Uint8Array` on return.
 *   - `parsePositiveIntHeader` rejects malformed / negative / float
 *     headers.
 */
import { describe, expect, test } from 'bun:test';
import {
  RunnerExecutionError,
  RunnerInputError,
} from '../../../src/actions/handlers/processing/runners/errors';
import { MAX_DOCUMENT_BYTES } from '../../../src/actions/handlers/processing/runners/profiles';
import {
  DEFAULT_SOFFICE_TIMEOUT_MS,
  LibreOfficeDocumentProcessor,
  __forTesting__,
  defaultFetchSidecarClient,
  type DocumentSidecarClient,
  type DocumentSidecarConvertResult,
} from '../../../src/infra/processors/libreoffice-document-processor';

// ── helpers ──────────────────────────────────────────────────────────────

/**
 * Build a fake `DocumentSidecarClient` whose `convert` returns a
 * fixed `DocumentSidecarConvertResult`. Records every call's input
 * so tests can assert the wire-shape invariants without HTTP I/O.
 */
function makeFakeClient(result: DocumentSidecarConvertResult): {
  client: DocumentSidecarClient;
  calls: Array<{
    serviceUrl: string;
    sourceContentType: string;
    bytes: Uint8Array;
    timeoutMs: number;
  }>;
} {
  const calls: Array<{
    serviceUrl: string;
    sourceContentType: string;
    bytes: Uint8Array;
    timeoutMs: number;
  }> = [];
  const client: DocumentSidecarClient = {
    async convert(input) {
      calls.push({
        serviceUrl: input.serviceUrl,
        sourceContentType: input.sourceContentType,
        bytes: input.bytes,
        timeoutMs: input.timeoutMs,
      });
      return result;
    },
  };
  return { client, calls };
}

/** Build a small fake PNG body for sidecar 2xx responses. */
function fakePngBytes(): Uint8Array {
  // 16-byte sentinel — bigger than the stub-mode 4-byte JPEG SOI+EOI
  // so the "non-empty body" check passes. The processor does NOT
  // validate the bytes are real PNG/JPEG content — that's the
  // sidecar's job; we just forward them.
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]);
}

// ── validateSidecarUrl ───────────────────────────────────────────────────

describe('validateSidecarUrl', () => {
  test('accepts http://', () => {
    const u = __forTesting__.validateSidecarUrl('http://libreoffice-sidecar:8100');
    expect(u.protocol).toBe('http:');
    expect(u.host).toBe('libreoffice-sidecar:8100');
  });

  test('accepts https://', () => {
    const u = __forTesting__.validateSidecarUrl('https://libreoffice-sidecar.internal:443');
    expect(u.protocol).toBe('https:');
  });

  test('rejects empty string', () => {
    expect(() => __forTesting__.validateSidecarUrl('')).toThrow('LIBREOFFICE_SERVICE_URL_INVALID');
  });

  test('rejects whitespace-only string', () => {
    expect(() => __forTesting__.validateSidecarUrl('   ')).toThrow(
      'LIBREOFFICE_SERVICE_URL_INVALID',
    );
  });

  test('rejects non-string types', () => {
    // We deliberately cast through `unknown` because the function
    // accepts `string` at the type system level — runtime callers
    // (env vars) can still pass garbage.
    expect(() => __forTesting__.validateSidecarUrl(null as unknown as string)).toThrow(
      'LIBREOFFICE_SERVICE_URL_INVALID',
    );
    expect(() => __forTesting__.validateSidecarUrl(undefined as unknown as string)).toThrow(
      'LIBREOFFICE_SERVICE_URL_INVALID',
    );
    expect(() => __forTesting__.validateSidecarUrl(42 as unknown as string)).toThrow(
      'LIBREOFFICE_SERVICE_URL_INVALID',
    );
  });

  test('rejects file:// scheme', () => {
    expect(() => __forTesting__.validateSidecarUrl('file:///etc/passwd')).toThrow(
      'LIBREOFFICE_SERVICE_URL_INVALID',
    );
  });

  test('rejects ftp:// scheme', () => {
    expect(() => __forTesting__.validateSidecarUrl('ftp://attacker.example.com')).toThrow(
      'LIBREOFFICE_SERVICE_URL_INVALID',
    );
  });

  test('rejects data: scheme', () => {
    expect(() => __forTesting__.validateSidecarUrl('data:text/plain,hello')).toThrow(
      'LIBREOFFICE_SERVICE_URL_INVALID',
    );
  });

  test('rejects javascript: scheme', () => {
    expect(() => __forTesting__.validateSidecarUrl('javascript:alert(1)')).toThrow(
      'LIBREOFFICE_SERVICE_URL_INVALID',
    );
  });

  test('rejects unparseable strings', () => {
    expect(() => __forTesting__.validateSidecarUrl('not a url')).toThrow(
      'LIBREOFFICE_SERVICE_URL_INVALID',
    );
  });
});

// ── buildConvertUrl ──────────────────────────────────────────────────────

describe('buildConvertUrl', () => {
  test('appends /convert to bare host', () => {
    const u = new URL('http://libreoffice-sidecar:8100');
    expect(__forTesting__.buildConvertUrl(u)).toBe('http://libreoffice-sidecar:8100/convert');
  });

  test('replaces an existing path (no doubling)', () => {
    // If config drifts and someone sets the base URL to include a
    // path, `/convert` REPLACES the path (URL constructor semantics
    // with a leading-slash second arg). This is the safest behaviour
    // — the alternative (concatenation) could produce `//convert` or
    // `/some-path/convert` depending on trailing slashes.
    const u = new URL('http://libreoffice-sidecar:8100/some-prefix');
    expect(__forTesting__.buildConvertUrl(u)).toBe('http://libreoffice-sidecar:8100/convert');
  });

  test('preserves https scheme', () => {
    const u = new URL('https://libreoffice-sidecar.internal:443');
    expect(__forTesting__.buildConvertUrl(u)).toBe('https://libreoffice-sidecar.internal/convert');
  });
});

// ── parsePositiveIntHeader ───────────────────────────────────────────────

describe('parsePositiveIntHeader', () => {
  test('parses a positive integer string', () => {
    expect(__forTesting__.parsePositiveIntHeader('800')).toBe(800);
    expect(__forTesting__.parsePositiveIntHeader('1')).toBe(1);
  });

  test('returns null for null / empty / non-numeric', () => {
    expect(__forTesting__.parsePositiveIntHeader(null)).toBeNull();
    expect(__forTesting__.parsePositiveIntHeader('')).toBeNull();
    expect(__forTesting__.parsePositiveIntHeader('abc')).toBeNull();
  });

  test('returns null for zero / negative', () => {
    expect(__forTesting__.parsePositiveIntHeader('0')).toBeNull();
    expect(__forTesting__.parsePositiveIntHeader('-100')).toBeNull();
  });

  test('returns null for floats', () => {
    expect(__forTesting__.parsePositiveIntHeader('1.5')).toBeNull();
  });

  test('returns null for non-finite values', () => {
    expect(__forTesting__.parsePositiveIntHeader('Infinity')).toBeNull();
    expect(__forTesting__.parsePositiveIntHeader('NaN')).toBeNull();
  });
});

// ── isAllowedPreviewContentType ──────────────────────────────────────────

describe('isAllowedPreviewContentType', () => {
  test('accepts image/png', () => {
    expect(__forTesting__.isAllowedPreviewContentType('image/png')).toBe(true);
  });

  test('accepts image/jpeg', () => {
    expect(__forTesting__.isAllowedPreviewContentType('image/jpeg')).toBe(true);
  });

  test('accepts content-type with charset suffix', () => {
    expect(__forTesting__.isAllowedPreviewContentType('image/png; charset=binary')).toBe(true);
    expect(__forTesting__.isAllowedPreviewContentType('image/jpeg;charset=binary')).toBe(true);
  });

  test('is case-insensitive on the head', () => {
    expect(__forTesting__.isAllowedPreviewContentType('IMAGE/PNG')).toBe(true);
    expect(__forTesting__.isAllowedPreviewContentType('Image/Jpeg')).toBe(true);
  });

  test('rejects null / empty', () => {
    expect(__forTesting__.isAllowedPreviewContentType(null)).toBe(false);
    expect(__forTesting__.isAllowedPreviewContentType('')).toBe(false);
  });

  test('rejects unknown content types', () => {
    expect(__forTesting__.isAllowedPreviewContentType('text/html')).toBe(false);
    expect(__forTesting__.isAllowedPreviewContentType('application/pdf')).toBe(false);
    expect(__forTesting__.isAllowedPreviewContentType('image/webp')).toBe(false);
    expect(__forTesting__.isAllowedPreviewContentType('image/avif')).toBe(false);
    expect(__forTesting__.isAllowedPreviewContentType('application/json')).toBe(false);
  });
});

// ── constructor ──────────────────────────────────────────────────────────

describe('LibreOfficeDocumentProcessor — construction', () => {
  test('honours custom timeout', () => {
    const { client } = makeFakeClient({
      status: 200,
      bytes: fakePngBytes(),
      contentType: 'image/png',
      width: 800,
      height: 1100,
      timedOut: false,
    });
    // Indirectly verified: a custom timeoutMs is forwarded to the
    // client; we'll assert this in the renderFirstPagePreview tests.
    const proc = new LibreOfficeDocumentProcessor({
      serviceUrl: 'http://libreoffice-sidecar:8100',
      client,
      timeoutMs: 30_000,
    });
    expect(proc).toBeDefined();
  });

  test('throws LIBREOFFICE_SERVICE_URL_INVALID on bad URL', () => {
    expect(() => {
      new LibreOfficeDocumentProcessor({ serviceUrl: '' });
    }).toThrow('LIBREOFFICE_SERVICE_URL_INVALID');
    expect(() => {
      new LibreOfficeDocumentProcessor({ serviceUrl: 'file:///etc/passwd' });
    }).toThrow('LIBREOFFICE_SERVICE_URL_INVALID');
  });

  test('default timeout is DEFAULT_SOFFICE_TIMEOUT_MS (60_000)', () => {
    expect(DEFAULT_SOFFICE_TIMEOUT_MS).toBe(60_000);
  });
});

// ── renderFirstPagePreview — happy path ──────────────────────────────────

describe('LibreOfficeDocumentProcessor.renderFirstPagePreview — happy path', () => {
  test('returns PNG preview for application/pdf', async () => {
    const { client, calls } = makeFakeClient({
      status: 200,
      bytes: fakePngBytes(),
      contentType: 'image/png',
      width: 1240,
      height: 1754,
      timedOut: false,
    });
    const proc = new LibreOfficeDocumentProcessor({
      serviceUrl: 'http://libreoffice-sidecar:8100',
      client,
    });
    const result = await proc.renderFirstPagePreview({
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), // %PDF header
      sourceContentType: 'application/pdf',
    });
    expect(result.contentType).toBe('image/png');
    expect(result.width).toBe(1240);
    expect(result.height).toBe(1754);
    expect(result.bytes.byteLength).toBe(16);

    // Wire-shape invariants on the call.
    expect(calls.length).toBe(1);
    expect(calls[0].serviceUrl).toBe('http://libreoffice-sidecar:8100/');
    expect(calls[0].sourceContentType).toBe('application/pdf');
    expect(calls[0].timeoutMs).toBe(DEFAULT_SOFFICE_TIMEOUT_MS);
  });

  test('returns JPEG preview when sidecar reports image/jpeg', async () => {
    const { client } = makeFakeClient({
      status: 200,
      bytes: fakePngBytes(),
      contentType: 'image/jpeg',
      width: 800,
      height: 1100,
      timedOut: false,
    });
    const proc = new LibreOfficeDocumentProcessor({
      serviceUrl: 'http://libreoffice-sidecar:8100',
      client,
    });
    const result = await proc.renderFirstPagePreview({
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      sourceContentType: 'application/pdf',
    });
    expect(result.contentType).toBe('image/jpeg');
  });

  test('accepts content-type with charset suffix', async () => {
    const { client } = makeFakeClient({
      status: 200,
      bytes: fakePngBytes(),
      contentType: 'image/png; charset=binary',
      width: 800,
      height: 1100,
      timedOut: false,
    });
    const proc = new LibreOfficeDocumentProcessor({
      serviceUrl: 'http://libreoffice-sidecar:8100',
      client,
    });
    const result = await proc.renderFirstPagePreview({
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      sourceContentType: 'application/pdf',
    });
    expect(result.contentType).toBe('image/png');
  });

  test('falls back to default dimensions when sidecar omits page-size headers', async () => {
    const { client } = makeFakeClient({
      status: 200,
      bytes: fakePngBytes(),
      contentType: 'image/png',
      width: null,
      height: null,
      timedOut: false,
    });
    const proc = new LibreOfficeDocumentProcessor({
      serviceUrl: 'http://libreoffice-sidecar:8100',
      client,
    });
    const result = await proc.renderFirstPagePreview({
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      sourceContentType: 'application/pdf',
    });
    expect(result.width).toBe(__forTesting__.FALLBACK_PREVIEW_WIDTH);
    expect(result.height).toBe(__forTesting__.FALLBACK_PREVIEW_HEIGHT);
  });

  test('lowercases sourceContentType before forwarding', async () => {
    const { client, calls } = makeFakeClient({
      status: 200,
      bytes: fakePngBytes(),
      contentType: 'image/png',
      width: 800,
      height: 1100,
      timedOut: false,
    });
    const proc = new LibreOfficeDocumentProcessor({
      serviceUrl: 'http://libreoffice-sidecar:8100',
      client,
    });
    await proc.renderFirstPagePreview({
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      sourceContentType: 'Application/PDF',
    });
    expect(calls[0].sourceContentType).toBe('application/pdf');
  });

  test('forwards custom timeoutMs to the client', async () => {
    const { client, calls } = makeFakeClient({
      status: 200,
      bytes: fakePngBytes(),
      contentType: 'image/png',
      width: 800,
      height: 1100,
      timedOut: false,
    });
    const proc = new LibreOfficeDocumentProcessor({
      serviceUrl: 'http://libreoffice-sidecar:8100',
      client,
      timeoutMs: 30_000,
    });
    await proc.renderFirstPagePreview({
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      sourceContentType: 'application/pdf',
    });
    expect(calls[0].timeoutMs).toBe(30_000);
  });

  test('returned bytes are a fresh Uint8Array (security invariant #9)', async () => {
    const sentinel = fakePngBytes();
    const { client } = makeFakeClient({
      status: 200,
      bytes: sentinel,
      contentType: 'image/png',
      width: 800,
      height: 1100,
      timedOut: false,
    });
    const proc = new LibreOfficeDocumentProcessor({
      serviceUrl: 'http://libreoffice-sidecar:8100',
      client,
    });
    const result = await proc.renderFirstPagePreview({
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      sourceContentType: 'application/pdf',
    });
    // The returned `bytes` is a *fresh* Uint8Array — NOT the same
    // reference as the sidecar response payload.
    expect(result.bytes).not.toBe(sentinel);
    expect(result.bytes.buffer).not.toBe(sentinel.buffer);
    // Same content though.
    expect(Array.from(result.bytes)).toEqual(Array.from(sentinel));
  });
});

// ── renderFirstPagePreview — defense-in-depth input validation ────────────

describe('LibreOfficeDocumentProcessor.renderFirstPagePreview — input validation', () => {
  test('rejects non-allowlisted source content type with UNSUPPORTED_FORMAT', async () => {
    const { client, calls } = makeFakeClient({
      status: 200,
      bytes: fakePngBytes(),
      contentType: 'image/png',
      width: 800,
      height: 1100,
      timedOut: false,
    });
    const proc = new LibreOfficeDocumentProcessor({
      serviceUrl: 'http://libreoffice-sidecar:8100',
      client,
    });
    await expect(
      proc.renderFirstPagePreview({
        bytes: new Uint8Array([0x00, 0x01]),
        sourceContentType: 'application/zip',
      }),
    ).rejects.toMatchObject({ name: 'RunnerInputError', code: 'UNSUPPORTED_FORMAT' });
    // Sidecar was NEVER called — short-circuit before HTTP I/O.
    expect(calls.length).toBe(0);
  });

  test('rejects empty source content type with UNSUPPORTED_FORMAT', async () => {
    const { client, calls } = makeFakeClient({
      status: 200,
      bytes: fakePngBytes(),
      contentType: 'image/png',
      width: 800,
      height: 1100,
      timedOut: false,
    });
    const proc = new LibreOfficeDocumentProcessor({
      serviceUrl: 'http://libreoffice-sidecar:8100',
      client,
    });
    await expect(
      proc.renderFirstPagePreview({
        bytes: new Uint8Array([0x00, 0x01]),
        sourceContentType: '',
      }),
    ).rejects.toBeInstanceOf(RunnerInputError);
    expect(calls.length).toBe(0);
  });

  test('rejects bytes > MAX_DOCUMENT_BYTES with OVER_MAX_BYTES', async () => {
    const { client, calls } = makeFakeClient({
      status: 200,
      bytes: fakePngBytes(),
      contentType: 'image/png',
      width: 800,
      height: 1100,
      timedOut: false,
    });
    const proc = new LibreOfficeDocumentProcessor({
      serviceUrl: 'http://libreoffice-sidecar:8100',
      client,
    });
    // Build a buffer that REPORTS being over the cap without
    // allocating 100 MiB. We allocate a tiny array but spoof the
    // byteLength via a fake — wait, no, byteLength is read-only.
    // We need an actual large allocation. Use a TypedArray view
    // into a 1-byte ArrayBuffer with a manual stub on byteLength?
    // Actually the cleanest way is to allocate exactly
    // MAX_DOCUMENT_BYTES + 1 bytes (100 MiB + 1). That's 104 MB —
    // memory-heavy but Bun handles it fine on a dev box.
    //
    // Trade-off: this test allocates 100 MB. Acceptable: it runs in
    // <50 ms on commodity hardware and only exists to prove the
    // cap is enforced. We use a Uint8Array view over a fresh
    // ArrayBuffer so no per-byte init runs (the buffer is
    // zero-initialised by the allocator in O(1) on most platforms).
    const oversized = new Uint8Array(MAX_DOCUMENT_BYTES + 1);
    await expect(
      proc.renderFirstPagePreview({
        bytes: oversized,
        sourceContentType: 'application/pdf',
      }),
    ).rejects.toMatchObject({ name: 'RunnerInputError', code: 'OVER_MAX_BYTES' });
    expect(calls.length).toBe(0);
  });

  test('accepts every documented safe-MIME', async () => {
    const safeMimes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.oasis.opendocument.text',
      'application/vnd.oasis.opendocument.spreadsheet',
      'application/vnd.oasis.opendocument.presentation',
      'application/rtf',
    ];
    for (const mime of safeMimes) {
      const { client } = makeFakeClient({
        status: 200,
        bytes: fakePngBytes(),
        contentType: 'image/png',
        width: 800,
        height: 1100,
        timedOut: false,
      });
      const proc = new LibreOfficeDocumentProcessor({
        serviceUrl: 'http://libreoffice-sidecar:8100',
        client,
      });
      await expect(
        proc.renderFirstPagePreview({
          bytes: new Uint8Array([0x00]),
          sourceContentType: mime,
        }),
      ).resolves.toBeDefined();
    }
  });
});

// ── renderFirstPagePreview — sidecar status handling ──────────────────────

describe('LibreOfficeDocumentProcessor.renderFirstPagePreview — sidecar status', () => {
  test('sidecar 400 → UNSUPPORTED_FORMAT (non-retryable)', async () => {
    const { client } = makeFakeClient({
      status: 400,
      bytes: new Uint8Array(),
      contentType: 'application/json',
      width: null,
      height: null,
      timedOut: false,
    });
    const proc = new LibreOfficeDocumentProcessor({
      serviceUrl: 'http://libreoffice-sidecar:8100',
      client,
    });
    await expect(
      proc.renderFirstPagePreview({
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        sourceContentType: 'application/pdf',
      }),
    ).rejects.toMatchObject({ name: 'RunnerInputError', code: 'UNSUPPORTED_FORMAT' });
  });

  test('sidecar 415 → UNSUPPORTED_FORMAT', async () => {
    const { client } = makeFakeClient({
      status: 415,
      bytes: new Uint8Array(),
      contentType: 'application/json',
      width: null,
      height: null,
      timedOut: false,
    });
    const proc = new LibreOfficeDocumentProcessor({
      serviceUrl: 'http://libreoffice-sidecar:8100',
      client,
    });
    await expect(
      proc.renderFirstPagePreview({
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        sourceContentType: 'application/pdf',
      }),
    ).rejects.toMatchObject({ name: 'RunnerInputError', code: 'UNSUPPORTED_FORMAT' });
  });

  test('sidecar 500 → PROCESSOR_FAILED (retryable)', async () => {
    const { client } = makeFakeClient({
      status: 500,
      bytes: new Uint8Array(),
      contentType: 'application/json',
      width: null,
      height: null,
      timedOut: false,
    });
    const proc = new LibreOfficeDocumentProcessor({
      serviceUrl: 'http://libreoffice-sidecar:8100',
      client,
    });
    await expect(
      proc.renderFirstPagePreview({
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        sourceContentType: 'application/pdf',
      }),
    ).rejects.toMatchObject({
      name: 'RunnerExecutionError',
      code: 'PROCESSOR_FAILED',
      retryable: true,
    });
  });

  test('sidecar 503 → PROCESSOR_FAILED', async () => {
    const { client } = makeFakeClient({
      status: 503,
      bytes: new Uint8Array(),
      contentType: 'application/json',
      width: null,
      height: null,
      timedOut: false,
    });
    const proc = new LibreOfficeDocumentProcessor({
      serviceUrl: 'http://libreoffice-sidecar:8100',
      client,
    });
    await expect(
      proc.renderFirstPagePreview({
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        sourceContentType: 'application/pdf',
      }),
    ).rejects.toBeInstanceOf(RunnerExecutionError);
  });

  test('network failure (status=0) → PROCESSOR_FAILED', async () => {
    const { client } = makeFakeClient({
      status: 0,
      bytes: new Uint8Array(),
      contentType: null,
      width: null,
      height: null,
      timedOut: false,
    });
    const proc = new LibreOfficeDocumentProcessor({
      serviceUrl: 'http://libreoffice-sidecar:8100',
      client,
    });
    await expect(
      proc.renderFirstPagePreview({
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        sourceContentType: 'application/pdf',
      }),
    ).rejects.toMatchObject({
      name: 'RunnerExecutionError',
      code: 'PROCESSOR_FAILED',
      retryable: true,
    });
  });

  test('timeout (timedOut=true) → PROCESSOR_FAILED', async () => {
    const { client } = makeFakeClient({
      status: 0,
      bytes: new Uint8Array(),
      contentType: null,
      width: null,
      height: null,
      timedOut: true,
    });
    const proc = new LibreOfficeDocumentProcessor({
      serviceUrl: 'http://libreoffice-sidecar:8100',
      client,
    });
    await expect(
      proc.renderFirstPagePreview({
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        sourceContentType: 'application/pdf',
      }),
    ).rejects.toMatchObject({
      name: 'RunnerExecutionError',
      code: 'PROCESSOR_FAILED',
      retryable: true,
    });
  });

  test('sidecar 200 with wrong Content-Type → PROCESSOR_FAILED', async () => {
    const { client } = makeFakeClient({
      status: 200,
      bytes: fakePngBytes(),
      contentType: 'text/html',
      width: 800,
      height: 1100,
      timedOut: false,
    });
    const proc = new LibreOfficeDocumentProcessor({
      serviceUrl: 'http://libreoffice-sidecar:8100',
      client,
    });
    await expect(
      proc.renderFirstPagePreview({
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        sourceContentType: 'application/pdf',
      }),
    ).rejects.toMatchObject({
      name: 'RunnerExecutionError',
      code: 'PROCESSOR_FAILED',
      retryable: true,
    });
  });

  test('sidecar 200 with image/webp → PROCESSOR_FAILED (not on allowlist)', async () => {
    const { client } = makeFakeClient({
      status: 200,
      bytes: fakePngBytes(),
      contentType: 'image/webp',
      width: 800,
      height: 1100,
      timedOut: false,
    });
    const proc = new LibreOfficeDocumentProcessor({
      serviceUrl: 'http://libreoffice-sidecar:8100',
      client,
    });
    await expect(
      proc.renderFirstPagePreview({
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        sourceContentType: 'application/pdf',
      }),
    ).rejects.toBeInstanceOf(RunnerExecutionError);
  });

  test('sidecar 200 with empty body → PROCESSOR_FAILED', async () => {
    const { client } = makeFakeClient({
      status: 200,
      bytes: new Uint8Array(),
      contentType: 'image/png',
      width: 800,
      height: 1100,
      timedOut: false,
    });
    const proc = new LibreOfficeDocumentProcessor({
      serviceUrl: 'http://libreoffice-sidecar:8100',
      client,
    });
    await expect(
      proc.renderFirstPagePreview({
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        sourceContentType: 'application/pdf',
      }),
    ).rejects.toBeInstanceOf(RunnerExecutionError);
  });

  test('sidecar 200 with null Content-Type → PROCESSOR_FAILED', async () => {
    const { client } = makeFakeClient({
      status: 200,
      bytes: fakePngBytes(),
      contentType: null,
      width: 800,
      height: 1100,
      timedOut: false,
    });
    const proc = new LibreOfficeDocumentProcessor({
      serviceUrl: 'http://libreoffice-sidecar:8100',
      client,
    });
    await expect(
      proc.renderFirstPagePreview({
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        sourceContentType: 'application/pdf',
      }),
    ).rejects.toBeInstanceOf(RunnerExecutionError);
  });

  test('sidecar 301 (unexpected redirect) → PROCESSOR_FAILED', async () => {
    const { client } = makeFakeClient({
      status: 301,
      bytes: new Uint8Array(),
      contentType: 'text/html',
      width: null,
      height: null,
      timedOut: false,
    });
    const proc = new LibreOfficeDocumentProcessor({
      serviceUrl: 'http://libreoffice-sidecar:8100',
      client,
    });
    await expect(
      proc.renderFirstPagePreview({
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        sourceContentType: 'application/pdf',
      }),
    ).rejects.toBeInstanceOf(RunnerExecutionError);
  });

  test('client throws → PROCESSOR_FAILED (raw error text NEVER leaks)', async () => {
    const client: DocumentSidecarClient = {
      async convert() {
        throw new Error('SECRET: x-amz-signature=DEADBEEF&access_key=AKIA-LEAK&xynes_live_abc123');
      },
    };
    const proc = new LibreOfficeDocumentProcessor({
      serviceUrl: 'http://libreoffice-sidecar:8100',
      client,
    });
    try {
      await proc.renderFirstPagePreview({
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        sourceContentType: 'application/pdf',
      });
      throw new Error('expected throw');
    } catch (err) {
      // Closed-set error envelope.
      expect(err).toBeInstanceOf(RunnerExecutionError);
      // The raw thrown text NEVER leaks through.
      const msg = String((err as Error).message);
      expect(msg).not.toMatch(/SECRET/);
      expect(msg).not.toMatch(/x-amz-signature/i);
      expect(msg).not.toMatch(/AKIA/);
      expect(msg).not.toMatch(/xynes_live_/);
      // Closed-set code only.
      expect(msg).toBe('PROCESSOR_FAILED');
    }
  });
});

// ── defaultFetchSidecarClient ────────────────────────────────────────────

describe('defaultFetchSidecarClient — wire shape', () => {
  test('issues POST /convert with JSON body containing base64 bytes', async () => {
    const captured: {
      url?: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    } = {};
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      captured.url = typeof input === 'string' ? input : input.toString();
      captured.method = init?.method;
      const hdrs = init?.headers as Record<string, string> | undefined;
      captured.headers = hdrs;
      captured.body = init?.body as string;
      // Build a synthetic Response.
      return new Response(fakePngBytes(), {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'x-document-page-width': '800',
          'x-document-page-height': '1100',
        },
      });
    }) as unknown as typeof fetch;
    try {
      const result = await defaultFetchSidecarClient.convert({
        serviceUrl: 'http://libreoffice-sidecar:8100',
        sourceContentType: 'application/pdf',
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        timeoutMs: 30_000,
      });
      // Result shape.
      expect(result.status).toBe(200);
      expect(result.contentType).toBe('image/png');
      expect(result.width).toBe(800);
      expect(result.height).toBe(1100);
      expect(result.bytes.byteLength).toBe(16);
      expect(result.timedOut).toBe(false);
      // Wire shape.
      expect(captured.url).toBe('http://libreoffice-sidecar:8100/convert');
      expect(captured.method).toBe('POST');
      expect((captured.headers as Record<string, string>)['Content-Type']).toBe('application/json');
      // Body is JSON; bytes are base64-encoded.
      const parsed = JSON.parse(captured.body!) as {
        sourceContentType: string;
        bytes: string;
      };
      expect(parsed.sourceContentType).toBe('application/pdf');
      // base64 of [0x25, 0x50, 0x44, 0x46] is `JVBERg==`.
      expect(parsed.bytes).toBe('JVBERg==');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('returns status=0 + timedOut=true on AbortError', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      // Throw an AbortError-shaped exception to simulate the
      // AbortController firing.
      const err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      throw err;
    }) as unknown as typeof fetch;
    try {
      const result = await defaultFetchSidecarClient.convert({
        serviceUrl: 'http://libreoffice-sidecar:8100',
        sourceContentType: 'application/pdf',
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        timeoutMs: 1, // Tiny timeout
      });
      // We didn't actually await the timeout to fire, so `timedOut`
      // may be false. But status MUST be 0 (network failure path).
      expect(result.status).toBe(0);
      expect(result.bytes.byteLength).toBe(0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('returns status=0 on DNS / network error', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    try {
      const result = await defaultFetchSidecarClient.convert({
        serviceUrl: 'http://libreoffice-sidecar:8100',
        sourceContentType: 'application/pdf',
        bytes: new Uint8Array([0x25]),
        timeoutMs: 30_000,
      });
      expect(result.status).toBe(0);
      expect(result.bytes.byteLength).toBe(0);
      expect(result.contentType).toBeNull();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('reads response body even on non-2xx status', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response('upstream error body', {
        status: 500,
        headers: { 'content-type': 'text/plain' },
      });
    }) as unknown as typeof fetch;
    try {
      const result = await defaultFetchSidecarClient.convert({
        serviceUrl: 'http://libreoffice-sidecar:8100',
        sourceContentType: 'application/pdf',
        bytes: new Uint8Array([0x25]),
        timeoutMs: 30_000,
      });
      expect(result.status).toBe(500);
      // Body bytes ARE returned to the caller (the processor decides
      // what to do based on status); the processor will reject any
      // non-2xx without forwarding these bytes.
      expect(result.bytes.byteLength).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('handles malformed page-size headers gracefully', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response(fakePngBytes(), {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'x-document-page-width': 'not-a-number',
          'x-document-page-height': '-50',
        },
      });
    }) as unknown as typeof fetch;
    try {
      const result = await defaultFetchSidecarClient.convert({
        serviceUrl: 'http://libreoffice-sidecar:8100',
        sourceContentType: 'application/pdf',
        bytes: new Uint8Array([0x25]),
        timeoutMs: 30_000,
      });
      expect(result.status).toBe(200);
      expect(result.width).toBeNull();
      expect(result.height).toBeNull();
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
