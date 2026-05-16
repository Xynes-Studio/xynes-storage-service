/**
 * STORAGE-8 — runner dependency-injection ports.
 *
 * Runners NEVER speak to sharp / ffmpeg / clamav directly. They invoke
 * an injected port. Production wires the port to a native binding
 * (sharp/libvips, ffmpeg, libreoffice headless, clamav daemon). Tests
 * inject in-memory fakes — same posture as STORAGE-4's adapter
 * boundary and STORAGE-5/6/7's repository contracts.
 *
 * SECURITY contract for ALL ports:
 *   - Ports MUST NOT log raw signed URLs, raw API keys, raw access /
 *     secret keys, raw provider error envelopes, file system paths,
 *     or credential references.
 *   - Ports MUST throw a `RunnerExecutionError` (retryable) for
 *     transient processor failures, and a `RunnerInputError`
 *     (non-retryable) for input-level rejections (e.g. malformed
 *     image, unsupported codec, scanner says infected).
 *   - Ports MUST NOT call back into the storage adapter directly —
 *     all provider I/O goes through the `ProviderObjectIO` port so the
 *     runner's blast radius is bounded.
 */
import type { ImageVariantSpec, VideoProfile, VariantRole } from './profiles';

// ── Provider object I/O ───────────────────────────────────────────────────

/**
 * Minimal I/O surface a runner needs against the provider:
 *   - `readObject`  : pull bytes for a stored object key.
 *   - `writeObject` : write a derivative object key, returning
 *                     the byte count actually persisted.
 *
 * Runners NEVER receive the raw `StorageProviderAdapter` — that would
 * give them access to signed-URL minting + multipart APIs they don't
 * need. The wiring layer narrows the adapter to this two-method port.
 *
 * STORAGE-FU-5: `workspaceId` and `providerId` are OPTIONAL routing hints
 * carried per-call so a production S3-backed implementation can resolve
 * the right workspace+provider adapter against the secret-managed
 * credential. Test fakes that operate on an in-memory keyspace MAY
 * ignore them. Production implementations that operate against a real
 * provider MUST honour them — otherwise they cannot pick the correct
 * `(endpoint, region, bucket, credentials)` tuple for a multi-workspace
 * deployment.
 */
export interface ProviderObjectIO {
  readObject(input: {
    objectKey: string;
    /**
     * STORAGE-FU-5: optional routing hint. Production impls resolve the
     * workspace's provider here; fakes MAY ignore. NEVER carries the
     * raw credential.
     */
    workspaceId?: string;
    /** STORAGE-FU-5: optional routing hint. See `workspaceId`. */
    providerId?: string;
  }): Promise<Uint8Array>;
  writeObject(input: {
    objectKey: string;
    body: Uint8Array;
    contentType: string;
    /** When true the writer MUST refuse if a row already exists. */
    ifAbsent?: boolean;
    /** STORAGE-FU-5: optional routing hint. See `readObject`. */
    workspaceId?: string;
    /** STORAGE-FU-5: optional routing hint. See `readObject`. */
    providerId?: string;
  }): Promise<{ byteSize: number }>;
}

// ── Variant writer ────────────────────────────────────────────────────────

/**
 * Records a variant row in `platform.storage_object_variants` after a
 * runner has successfully written derivative bytes to the provider.
 * The writer also enforces "do not overwrite the original" — variants
 * MUST use a derivative key (typically prefixed with
 * `variants/<role>/`) that is distinct from `object.providerObjectKey`.
 */
export interface VariantRecord {
  readonly objectId: string;
  readonly workspaceId: string;
  readonly role: VariantRole;
  readonly providerObjectKey: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly width?: number;
  readonly height?: number;
  readonly durationSeconds?: number;
}

export interface StorageVariantWriter {
  /**
   * Record a successful variant. Implementations MUST refuse if the
   * variant's `providerObjectKey` matches the parent object's
   * `providerObjectKey` — the original is sacred.
   */
  recordVariant(input: VariantRecord): Promise<void>;
}

// ── Image processor port ─────────────────────────────────────────────────

export interface ImageProbeResult {
  readonly width: number;
  readonly height: number;
  /** Detected format (jpeg, png, webp, etc). */
  readonly format: string;
  /** True iff the source carried any of the metadata stripping targets. */
  readonly hasGpsExif?: boolean;
}

export interface ImageVariantRender {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** Effective format the processor wrote (may downgrade `original`). */
  readonly format: 'avif' | 'webp' | 'jpeg' | 'png';
  /** MIME type for the rendered bytes. */
  readonly contentType: string;
}

/**
 * Image processor port. Production wires this to a sharp/libvips
 * binding; tests inject a fake that returns deterministic bytes.
 *
 * EXIF stripping invariant: `renderVariant` MUST strip GPS EXIF, IPTC
 * personally identifying tags, and camera serial numbers before
 * returning bytes — defense in depth on top of the orientation
 * normalisation built into libvips.
 */
export interface ImageProcessor {
  probe(input: { bytes: Uint8Array }): Promise<ImageProbeResult>;
  renderVariant(input: { bytes: Uint8Array; spec: ImageVariantSpec }): Promise<ImageVariantRender>;
}

// ── Video processor port ─────────────────────────────────────────────────

export interface VideoProbeResult {
  readonly durationSeconds: number;
  readonly width: number;
  readonly height: number;
  /** Container format (mp4, mov, webm, mkv). */
  readonly container: string;
  /** Video codec (h264, hevc, av1, vp9). */
  readonly videoCodec: string;
  /** Audio codec, when audio stream is present. */
  readonly audioCodec: string | null;
  /** Camera-recorded rotation, when present. */
  readonly rotationDegrees: number | null;
}

export interface VideoPosterRender {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly contentType: 'image/jpeg' | 'image/webp';
}

export interface VideoTranscodeRender {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly durationSeconds: number;
  readonly contentType: 'video/mp4';
}

export interface VideoProcessor {
  probe(input: { bytes: Uint8Array }): Promise<VideoProbeResult>;
  renderPoster(input: { bytes: Uint8Array; profile: VideoProfile }): Promise<VideoPosterRender>;
  renderTranscode(input: {
    bytes: Uint8Array;
    profile: VideoProfile;
  }): Promise<VideoTranscodeRender>;
}

// ── Document processor port ──────────────────────────────────────────────

export interface DocumentPreviewRender {
  readonly bytes: Uint8Array;
  /** Preview is delivered as PNG or JPEG — never the original format. */
  readonly contentType: 'image/png' | 'image/jpeg';
  readonly width: number;
  readonly height: number;
}

export interface DocumentProcessor {
  renderFirstPagePreview(input: {
    bytes: Uint8Array;
    sourceContentType: string;
  }): Promise<DocumentPreviewRender>;
}

// ── Malware scanner port ─────────────────────────────────────────────────

export type MalwareScanResult =
  | { readonly verdict: 'clean' }
  | { readonly verdict: 'infected'; readonly signature?: string }
  | { readonly verdict: 'unknown' };

export interface MalwareScanner {
  scan(input: { bytes: Uint8Array }): Promise<MalwareScanResult>;
}

/**
 * No-op malware scanner for local dev. ALWAYS returns `clean`.
 *
 * Hosted environments MUST inject a real scanner (e.g. clamav-rest
 * sidecar) — STORAGE-9 owns the "scanner availability" rollout
 * checklist item.
 */
export const noopMalwareScanner: MalwareScanner = {
  async scan() {
    return { verdict: 'clean' };
  },
};
