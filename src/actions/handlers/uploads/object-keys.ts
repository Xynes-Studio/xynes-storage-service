/**
 * Provider object-key derivation.
 *
 * Plan §STORAGE-9: object keys include workspace/object boundaries AND
 * are unguessable enough to avoid enumeration.
 *
 * Layout: `workspaces/<workspaceId>/objects/<objectId>/<safeFilename>`
 *
 *   - `workspaceId` segment scopes every object to one workspace at the
 *     bucket layout level. Cross-workspace enumeration would have to
 *     guess BOTH the workspace UUID AND the object UUID.
 *   - `objectId` segment is a UUID v4 minted at create-session time —
 *     128 bits of entropy. Random enough that brute-force enumeration
 *     of a workspace's objects is infeasible.
 *   - `safeFilename` is the sanitised user-supplied filename appended
 *     after the IDs purely for operator-side debuggability (e.g. when
 *     looking at provider console URLs). It NEVER changes semantic
 *     scoping — sanitisation strips ASCII control, path separators,
 *     and provider-reserved chars.
 *
 * The full key is bounded to ≤ 1024 bytes (AWS S3 limit; enforced by the
 * adapter as well). When the user-supplied filename is long enough to
 * exceed the limit, we truncate the `safeFilename` segment only — the
 * UUID segments are never truncated.
 */

const KEY_MAX_BYTES = 1024;
const FILENAME_MAX_SEGMENT_BYTES = 200; // Leaves comfortable headroom.

/**
 * Strip path separators, ASCII control chars, and provider-reserved
 * chars. Keeps alphanumerics, dot, dash, underscore. Anything else
 * collapses to `_`. Multiple consecutive `_` collapse to one. We
 * lowercase the result to avoid case-collision surprises on
 * case-insensitive providers.
 */
export function sanitiseFilenameSegment(filename: string): string {
  if (typeof filename !== 'string') return 'file';
  const trimmed = filename.trim();
  if (trimmed.length === 0) return 'file';

  // Replace anything not in the safe set with `_`.
  const ascii = trimmed
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/\x00-\x1f\x7f]/g, '_')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[._]+/, '') // No leading dot / underscore (avoid `.dotfile` providers tripping).
    .replace(/[._]+$/, '')
    .toLowerCase();

  if (ascii.length === 0) return 'file';

  // Byte-bound the filename segment.
  if (Buffer.byteLength(ascii, 'utf8') <= FILENAME_MAX_SEGMENT_BYTES) {
    return ascii;
  }
  // Truncate from the right (preserve extension if possible).
  const dotIdx = ascii.lastIndexOf('.');
  if (dotIdx > 0 && dotIdx > ascii.length - 16) {
    const ext = ascii.slice(dotIdx); // includes the dot.
    const stem = ascii.slice(0, dotIdx);
    const stemBytes = FILENAME_MAX_SEGMENT_BYTES - Buffer.byteLength(ext, 'utf8');
    if (stemBytes > 0) {
      return stem.slice(0, stemBytes) + ext;
    }
  }
  return ascii.slice(0, FILENAME_MAX_SEGMENT_BYTES);
}

export interface DeriveObjectKeyInput {
  readonly workspaceId: string;
  readonly objectId: string;
  readonly filename: string;
}

export function deriveProviderObjectKey(input: DeriveObjectKeyInput): string {
  const safe = sanitiseFilenameSegment(input.filename);
  const candidate = `workspaces/${input.workspaceId}/objects/${input.objectId}/${safe}`;
  if (Buffer.byteLength(candidate, 'utf8') <= KEY_MAX_BYTES) {
    return candidate;
  }
  // If we somehow built a too-long key (very long filename + worst-case UUIDs),
  // fall back to a filename-less key. The UUIDs are still in the path so
  // there is no information loss for the system; operator debuggability
  // takes the hit.
  return `workspaces/${input.workspaceId}/objects/${input.objectId}/file`;
}
