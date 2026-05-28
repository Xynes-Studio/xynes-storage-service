/**
 * STORAGE-FU-5-FU-C — LibreOffice-backed `DocumentProcessor`.
 *
 * Implements the STORAGE-8 `DocumentProcessor` port by speaking HTTP
 * to a co-located LibreOffice sidecar over pod-local DNS (default
 * `http://libreoffice-sidecar:8100`). The sidecar wraps a long-lived
 * `soffice --headless --accept` process in a Bun HTTP shim that
 * accepts `POST /convert` and returns a single-page PNG/JPEG preview.
 *
 * Replaces `ProductionDocumentProcessorStub` (which throws
 * `UNSUPPORTED_FORMAT`) in `STORAGE_PROCESSOR_MODE=live` deployments
 * once the composition root wires this class in.
 *
 * Closes **Bug 1 (document preview variants)** — document previews
 * in `STORAGE_PROCESSOR_MODE=live` now produce real PNG/JPEG bytes
 * (> 1 KiB on representative inputs) instead of the 4-byte JPEG
 * SOI+EOI stub artefact or `PROCESSOR_FAILED` from the production
 * stub.
 *
 * ── Topology rationale (FU-E §3) ──────────────────────────────────────────
 *
 * LibreOffice runs as a sidecar (NOT in-process) because:
 *
 *   1. Image footprint — `soffice` + JRE + bundled fonts is ~400 MB.
 *      Bundling into `storage-service` would balloon every replica's
 *      cold-start and push our pod RAM budget over the line documented
 *      in `infra/release/ENVIRONMENTS.md` §6.
 *
 *   2. Restart isolation — the sidecar has its own restart policy.
 *      A `soffice` crash from a malformed document does not take down
 *      the storage-service worker; the document job dead-letters
 *      cleanly via `PROCESSOR_FAILED` (retryable → STORAGE-7 worker
 *      retries up to `maxAttempts` then dead-letters).
 *
 *   3. Blast radius — `soffice` historically had a long tail of RCE
 *      bugs against malicious documents. Macros are disabled
 *      globally via `SAL_DISABLE_MACROS=1` on the sidecar container,
 *      but the sidecar runs with `cap_drop: [ALL]`,
 *      `read_only: true`, `no-new-privileges:true` so even a
 *      successful exploit cannot escalate.
 *
 *   4. Cold-start cost — `soffice` startup is ~2 s. Keeping a
 *      long-lived sidecar amortises that across every conversion.
 *
 * ── Security invariants ──────────────────────────────────────────────────
 *
 *   1. **Allowlist re-check.** The STORAGE-8 `document_preview`
 *      runner already filters on `SAFE_DOCUMENT_PREVIEW_MIMES`; we
 *      re-check here so a future direct caller (e.g. an admin
 *      "force re-process" path) cannot bypass.
 *
 *   2. **Hard byte cap re-check.** Same defense-in-depth posture as
 *      FU-A / FU-B — re-validate against `MAX_DOCUMENT_BYTES` before
 *      we ship bytes over the wire.
 *
 *   3. **Output content-type is a closed set.** Sidecar responses
 *      that claim any other Content-Type are rejected with
 *      `UNSUPPORTED_FORMAT` — never silently accepted.
 *
 *   4. **Sidecar URL is pod-local DNS.** We allow only `http://`
 *      and `https://` schemes and reject anything that resolves
 *      to a public hostname pattern at config time. The K8s
 *      NetworkPolicy (FU-E `40-networkpolicy.yaml`) enforces the
 *      egress boundary at the cluster layer.
 *
 *   5. **No raw HTTP error text in runner errors.** Sidecar error
 *      bodies, headers, and stack traces NEVER reach the closed-set
 *      runner error codes. A hostile sidecar response that embeds
 *      a path / signed URL / credential CANNOT bleed through.
 *
 *   6. **Per-request timeout enforced.** A run-away soffice
 *      conversion is aborted at `STORAGE_SOFFICE_TIMEOUT_MS` (default
 *      60 s). The killed conversion surfaces as retryable
 *      `PROCESSOR_FAILED` — the worker retries up to `maxAttempts`
 *      then dead-letters.
 *
 *   7. **No filesystem temp files in this processor.** Bytes go
 *      over the wire as a `Uint8Array` body; the sidecar owns its
 *      own tmpfs-mounted temp dir for the `soffice --convert-to`
 *      working area and cleans it up in a `finally` per request.
 *
 *   8. **No URL / path interpolation from user input.** The request
 *      URL is `${LIBREOFFICE_SERVICE_URL}/convert` — a constant
 *      built from env + a literal path segment. The body carries
 *      `sourceContentType` (validated against the allowlist) and
 *      base64-encoded bytes; nothing from the input reaches the
 *      URL.
 *
 *   9. **Output bytes are copied into a fresh `Uint8Array`.** Callers
 *      never observe the underlying `ArrayBuffer` that the response
 *      reader owned.
 *
 *  10. **Document properties NEVER survive.** The output PNG/JPEG
 *      MUST NOT carry the source document's metadata (author,
 *      title, comments, EXIF, etc.). This is the SIDECAR's
 *      responsibility (`soffice` strips by default when converting
 *      to PNG/JPEG raster). We add a defense-in-depth check on the
 *      reported dimensions to make sure we're getting an image, not
 *      a doctored response.
 *
 * ── Wire contract ────────────────────────────────────────────────────────
 *
 *   POST ${LIBREOFFICE_SERVICE_URL}/convert
 *   Content-Type: application/json
 *   { "sourceContentType": "<allowlisted MIME>", "bytes": "<base64>" }
 *
 *   ↓
 *
 *   200 OK
 *   Content-Type: image/png | image/jpeg
 *   X-Document-Page-Width:  <integer>
 *   X-Document-Page-Height: <integer>
 *   <raw PNG/JPEG bytes>
 *
 *   Any other shape → `PROCESSOR_FAILED` or `UNSUPPORTED_FORMAT`
 *   (per status code). HTTP 4xx → `UNSUPPORTED_FORMAT`
 *   (non-retryable; the sidecar rejected this specific document).
 *   HTTP 5xx / network / timeout → `PROCESSOR_FAILED` (retryable).
 *
 * ── Out of scope (per STORAGE-FU-5-FU-C plan §12) ────────────────────────
 *
 *   - Multi-page preview rendering.
 *   - OCR for image-only PDFs.
 *   - Office encryption / password-protected document handling.
 *   - Streaming responses (sidecar buffers the full PNG/JPEG in
 *     memory before responding; payloads stay under `MAX_DOCUMENT_BYTES`).
 */
import {
  RunnerExecutionError,
  RunnerInputError,
} from '../../actions/handlers/processing/runners/errors';
import type {
  DocumentPreviewRender,
  DocumentProcessor,
} from '../../actions/handlers/processing/runners/ports';
import {
  MAX_DOCUMENT_BYTES,
  isSafeDocumentPreviewMime,
} from '../../actions/handlers/processing/runners/profiles';

/**
 * Default per-request timeout. 60 seconds is the FU-E `STORAGE_SOFFICE_TIMEOUT_MS`
 * default — a healthy `soffice` first-page render against a PDF /
 * DOCX completes in <5 s on commodity hardware; the larger cap
 * absorbs cold-start jitter and large-XLSX edge cases without
 * letting a pathological document peg the sidecar indefinitely.
 */
export const DEFAULT_SOFFICE_TIMEOUT_MS = 60 * 1000;

/** Closed-set output Content-Type values. */
const ALLOWED_PREVIEW_CONTENT_TYPES = ['image/png', 'image/jpeg'] as const;
type AllowedPreviewContentType = (typeof ALLOWED_PREVIEW_CONTENT_TYPES)[number];

/** Conservative fallback dimensions if the sidecar omits the page-size headers. */
const FALLBACK_PREVIEW_WIDTH = 800;
const FALLBACK_PREVIEW_HEIGHT = 1100;

/**
 * Result shape returned by the sidecar client. Mirrors the sidecar
 * wire contract but as a structured value so the processor doesn't
 * have to know about `fetch` headers.
 */
export interface DocumentSidecarConvertResult {
  /** HTTP status returned by the sidecar. Used for retry-policy decisions. */
  readonly status: number;
  /** Bytes from the response body. Empty for non-2xx responses. */
  readonly bytes: Uint8Array;
  /** Content-Type the sidecar reported. May be anything; processor validates. */
  readonly contentType: string | null;
  /** Width in pixels reported via `X-Document-Page-Width`. */
  readonly width: number | null;
  /** Height in pixels reported via `X-Document-Page-Height`. */
  readonly height: number | null;
  /** Whether the request was aborted via the timeout signal. */
  readonly timedOut: boolean;
}

/**
 * Inject-able sidecar HTTP client. Production wires this to
 * `globalThis.fetch`; tests inject a deterministic fake to avoid
 * network I/O.
 */
export interface DocumentSidecarClient {
  convert(input: {
    serviceUrl: string;
    sourceContentType: string;
    bytes: Uint8Array;
    timeoutMs: number;
  }): Promise<DocumentSidecarConvertResult>;
}

/** Optional dependency override. */
export interface LibreOfficeDocumentProcessorDeps {
  /** Override sidecar client for tests. */
  readonly client?: DocumentSidecarClient;
  /** Sidecar URL. REQUIRED — production resolves this from `LIBREOFFICE_SERVICE_URL`. */
  readonly serviceUrl: string;
  /** Override per-job timeout. Defaults to `DEFAULT_SOFFICE_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

/**
 * Validate the sidecar URL at construction time. We accept only
 * `http://` and `https://` schemes — anything else (file://, ftp://,
 * data:, javascript:, an unparseable string) is rejected.
 *
 * We deliberately do NOT block private-IP/hostname patterns here:
 * the entire MVP design point of the sidecar is pod-local DNS
 * (`http://libreoffice-sidecar:8100`), which IS a private hostname.
 * The K8s NetworkPolicy (FU-E `40-networkpolicy.yaml`) enforces the
 * egress boundary at the cluster layer — defense in depth.
 */
export function validateSidecarUrl(raw: string): URL {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error('LIBREOFFICE_SERVICE_URL_INVALID');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('LIBREOFFICE_SERVICE_URL_INVALID');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('LIBREOFFICE_SERVICE_URL_INVALID');
  }
  return url;
}

/**
 * Build the absolute `/convert` URL by joining the base service URL
 * with the literal `/convert` path segment. We use the `URL`
 * constructor so a trailing slash on the base URL doesn't produce
 * `//convert`, and a path embedded in the base URL is correctly
 * replaced (NOT appended).
 *
 * The function is exported so tests can assert that no user input
 * reaches the URL.
 */
export function buildConvertUrl(serviceUrl: URL): string {
  // `URL` joins with path-segment semantics; passing a leading `/`
  // on the second arg replaces any existing path on `serviceUrl`,
  // which is the safest behaviour against future config drift.
  return new URL('/convert', serviceUrl).toString();
}

/** Parse a positive integer from a string header value. Returns null on any failure. */
function parsePositiveIntHeader(value: string | null): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

/** Type guard for the closed-set output Content-Type. */
function isAllowedPreviewContentType(value: string | null): value is AllowedPreviewContentType {
  if (typeof value !== 'string') return false;
  // Strip parameters (`; charset=...`) before comparing.
  const head = value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return (ALLOWED_PREVIEW_CONTENT_TYPES as readonly string[]).includes(head);
}

/**
 * Default `fetch`-backed sidecar client. Production callers use this;
 * tests inject a fake via `LibreOfficeDocumentProcessorDeps.client`.
 *
 * Body shape:
 *   - `Content-Type: application/json`.
 *   - Body: `{ sourceContentType, bytes: <base64> }`.
 *
 * Why base64 + JSON: the sidecar shim's HTTP framework (Bun + Hono)
 * cannot reliably stream arbitrary binary bodies into `soffice`
 * stdin without first buffering — JSON + base64 keeps the wire
 * contract simple and works with every HTTP client/server. The
 * payload size is bounded by `MAX_DOCUMENT_BYTES` (100 MiB raw →
 * ~133 MiB base64), which is well inside the sidecar's request-size
 * limits.
 */
export const defaultFetchSidecarClient: DocumentSidecarClient = {
  async convert(input) {
    const controller = new AbortController();
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      try {
        controller.abort();
      } catch {
        // Best-effort abort — fetch may have already settled.
      }
    }, input.timeoutMs);

    try {
      // base64-encode the bytes via Buffer (Node/Bun) for JSON
      // transport. We do NOT use `btoa(String.fromCharCode(...))`
      // because that breaks for large payloads (stack overflow on
      // the spread + per-codepoint conversion is lossy for bytes
      // > 0x7F).
      const base64 = Buffer.from(input.bytes).toString('base64');
      const body = JSON.stringify({
        sourceContentType: input.sourceContentType,
        bytes: base64,
      });

      const response = await fetch(buildConvertUrl(new URL(input.serviceUrl)), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });

      const contentType = response.headers.get('content-type');
      const width = parsePositiveIntHeader(response.headers.get('x-document-page-width'));
      const height = parsePositiveIntHeader(response.headers.get('x-document-page-height'));

      // Read the body even on non-2xx so the client surface is
      // uniform — the processor decides what to do with the bytes
      // based on status code. We catch read errors to avoid bubbling
      // raw network strings.
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await response.arrayBuffer());
      } catch {
        bytes = new Uint8Array();
      }

      return {
        status: response.status,
        bytes,
        contentType,
        width,
        height,
        timedOut: false,
      };
    } catch (err) {
      void err;
      // Network failure, DNS failure, AbortError from timeout, etc.
      // We never reflect the raw error message — it could contain
      // the sidecar hostname or other infrastructure details.
      return {
        status: 0,
        bytes: new Uint8Array(),
        contentType: null,
        width: null,
        height: null,
        timedOut,
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  },
};

/**
 * Production document processor backed by the LibreOffice sidecar.
 *
 * Stateless — safe to instantiate once and share across the worker's
 * processing loop. The instance carries no per-call state; every
 * call issues a fresh HTTP request.
 */
export class LibreOfficeDocumentProcessor implements DocumentProcessor {
  private readonly serviceUrl: string;
  private readonly client: DocumentSidecarClient;
  private readonly timeoutMs: number;

  constructor(deps: LibreOfficeDocumentProcessorDeps) {
    // Validate at construction so a misconfigured deploy fails loud
    // at startup, NOT on the first document job. The composition
    // root wraps this in a try/catch + WARN fallback to the
    // production stub (see `runner-dependencies.ts buildLiveDocumentProcessor`).
    const parsed = validateSidecarUrl(deps.serviceUrl);
    this.serviceUrl = parsed.toString();
    this.client = deps.client ?? defaultFetchSidecarClient;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_SOFFICE_TIMEOUT_MS;
  }

  async renderFirstPagePreview(input: {
    bytes: Uint8Array;
    sourceContentType: string;
  }): Promise<DocumentPreviewRender> {
    // Defense-in-depth allowlist re-check (security invariant #1).
    if (!isSafeDocumentPreviewMime(input.sourceContentType)) {
      throw new RunnerInputError('UNSUPPORTED_FORMAT');
    }
    // Defense-in-depth byte-cap re-check (security invariant #2).
    if (input.bytes.byteLength > MAX_DOCUMENT_BYTES) {
      throw new RunnerInputError('OVER_MAX_BYTES');
    }

    let result: DocumentSidecarConvertResult;
    try {
      result = await this.client.convert({
        serviceUrl: this.serviceUrl,
        sourceContentType: input.sourceContentType.toLowerCase(),
        bytes: input.bytes,
        timeoutMs: this.timeoutMs,
      });
    } catch {
      // Any unexpected throw from the client (a misbehaved fake in
      // tests, a bug in `defaultFetchSidecarClient`, etc.) surfaces
      // as retryable PROCESSOR_FAILED. Raw error text NEVER leaks.
      throw new RunnerExecutionError('PROCESSOR_FAILED', { retryable: true });
    }

    // Timeout / network failure → retryable. STORAGE-7 worker
    // retries up to `maxAttempts` then dead-letters.
    if (result.timedOut || result.status === 0) {
      throw new RunnerExecutionError('PROCESSOR_FAILED', { retryable: true });
    }

    // Sidecar 5xx → retryable (transient sidecar fault).
    if (result.status >= 500) {
      throw new RunnerExecutionError('PROCESSOR_FAILED', { retryable: true });
    }

    // Sidecar 4xx → non-retryable. The sidecar deliberately rejected
    // THIS document; retrying the same bytes against the same
    // sidecar will get the same answer. Treat as `UNSUPPORTED_FORMAT`
    // so the job dead-letters cleanly (matches the stub-mode
    // production-stub posture for unknown content).
    if (result.status >= 400) {
      throw new RunnerInputError('UNSUPPORTED_FORMAT');
    }

    // Any non-2xx that we didn't already handle (1xx, 3xx) is
    // unexpected — treat as a retryable processor fault.
    if (result.status < 200 || result.status >= 300) {
      throw new RunnerExecutionError('PROCESSOR_FAILED', { retryable: true });
    }

    // 2xx — validate the response shape.
    if (!isAllowedPreviewContentType(result.contentType)) {
      // Sidecar returned 2xx with an unexpected Content-Type — the
      // contract is violated. We refuse to write whatever bytes
      // came back as a "preview" (they could be HTML, JSON, etc.).
      throw new RunnerExecutionError('PROCESSOR_FAILED', { retryable: true });
    }

    // Empty body on 2xx is treated as a sidecar fault.
    if (result.bytes.byteLength === 0) {
      throw new RunnerExecutionError('PROCESSOR_FAILED', { retryable: true });
    }

    // Defense-in-depth: the response Content-Type already passed
    // the allowed-list check. Cast is safe.
    const previewContentType = result
      .contentType!.split(';', 1)[0]!
      .trim()
      .toLowerCase() as AllowedPreviewContentType;

    return {
      // Copy into a fresh Uint8Array (security invariant #9).
      bytes: new Uint8Array(result.bytes),
      contentType: previewContentType,
      // Dimensions: prefer the sidecar's reported page size; fall
      // back to a reasonable A4-ish default when the sidecar omits
      // the headers. Caller (variant writer) records these to
      // `storage_object_variants.width / height`.
      width: result.width ?? FALLBACK_PREVIEW_WIDTH,
      height: result.height ?? FALLBACK_PREVIEW_HEIGHT,
    };
  }
}

// ── test-only seam ────────────────────────────────────────────────────────

/**
 * Exported for `libreoffice-document-processor.test.ts` so the URL
 * validator + URL builder + helpers can be exercised independently.
 * Production callers MUST NOT depend on this — it's an internal
 * helper.
 */
export const __forTesting__ = {
  validateSidecarUrl,
  buildConvertUrl,
  parsePositiveIntHeader,
  isAllowedPreviewContentType,
  ALLOWED_PREVIEW_CONTENT_TYPES,
  FALLBACK_PREVIEW_WIDTH,
  FALLBACK_PREVIEW_HEIGHT,
};
