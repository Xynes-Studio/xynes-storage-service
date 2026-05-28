/**
 * STORAGE-FU-5-FU-G — Safe-document MIME allowlist.
 *
 * Mirrors `SAFE_DOCUMENT_PREVIEW_MIMES` in
 * `xynes-storage-service/src/actions/handlers/processing/runners/profiles.ts`
 * byte-for-byte. Adding a new MIME requires updating BOTH lists. The
 * shim re-checks defense in depth even though FU-C already filtered
 * upstream — a future direct caller (e.g. an admin "force re-process"
 * path) must not be able to bypass.
 *
 * Each entry maps to the soffice `--convert-to` profile and the input
 * file extension the soffice CLI expects. `profile` follows soffice's
 * documented format syntax — see
 * https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html
 */
export interface SafeMimeEntry {
  /** Wire-form Content-Type (lowercase). */
  readonly mime: string;
  /** File extension soffice expects (no leading dot). */
  readonly inputExtension: string;
  /**
   * soffice `--convert-to` profile string. We always emit PNG so the
   * shim has a single output Content-Type to advertise.
   *
   * "png" alone is enough for Writer / Calc; Impress + Draw / PDF
   * still produce a PNG when given just "png" — the output PNG
   * represents the first page / slide.
   */
  readonly convertProfile: 'png';
}

/**
 * Closed-set allowlist. Adding a new entry here MUST be paired with
 * `SAFE_DOCUMENT_PREVIEW_MIMES` in xynes-storage-service profiles.ts.
 * The static validator at `scripts/test/storage-fu-5-fu-g-libreoffice-sidecar.test.sh`
 * asserts every member appears in BOTH lists.
 */
export const SAFE_DOCUMENT_PREVIEW_MIMES: ReadonlyArray<SafeMimeEntry> = Object.freeze([
  { mime: 'application/pdf', inputExtension: 'pdf', convertProfile: 'png' },
  { mime: 'application/msword', inputExtension: 'doc', convertProfile: 'png' },
  {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    inputExtension: 'docx',
    convertProfile: 'png',
  },
  {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    inputExtension: 'xlsx',
    convertProfile: 'png',
  },
  {
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    inputExtension: 'pptx',
    convertProfile: 'png',
  },
  {
    mime: 'application/vnd.oasis.opendocument.text',
    inputExtension: 'odt',
    convertProfile: 'png',
  },
  {
    mime: 'application/vnd.oasis.opendocument.spreadsheet',
    inputExtension: 'ods',
    convertProfile: 'png',
  },
  {
    mime: 'application/vnd.oasis.opendocument.presentation',
    inputExtension: 'odp',
    convertProfile: 'png',
  },
  { mime: 'application/rtf', inputExtension: 'rtf', convertProfile: 'png' },
]);

/**
 * Returns the safe-MIME entry for a wire Content-Type, or null if
 * unknown. Strips charset parameters and lower-cases before matching.
 */
export function resolveSafeMime(value: string | null | undefined): SafeMimeEntry | null {
  if (typeof value !== 'string') return null;
  const head = value.split(';', 1)[0]?.trim().toLowerCase();
  if (!head) return null;
  for (const entry of SAFE_DOCUMENT_PREVIEW_MIMES) {
    if (entry.mime === head) return entry;
  }
  return null;
}

/**
 * Hard byte cap. Mirrors `MAX_DOCUMENT_BYTES` in xynes-storage-service
 * profiles.ts. The shim re-checks defense in depth — FU-C already
 * rejects > 100 MiB upstream.
 */
export const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024; // 100 MiB
