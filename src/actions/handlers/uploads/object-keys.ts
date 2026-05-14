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
 * Permissive UUID-shape regex (accepts v1/v4/v5 and any 8-4-4-4-12 hex
 * grouping). We deliberately do NOT pin to v4 specifically because future
 * id sources might use v7 or another variant; the property we care about
 * here is "exactly 32 hex chars with the standard dashes — no path
 * separators, no `..`, no NUL bytes, no slashes". Case-insensitive.
 */
const UUID_SHAPE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/**
 * Thrown when `deriveProviderObjectKey` is called with an id that does not
 * match the documented UUID shape. The error message is deliberately
 * generic — it does NOT echo the offending input back so a hostile caller
 * cannot use it as an oracle.
 *
 * Defense-in-depth: `internal.route.ts` already UUID-validates
 * `X-Workspace-Id`, and the upload handlers mint `objectId` via
 * `crypto.randomUUID()`. This guard ensures the function is safe to call
 * from any future caller without relying on upstream validation.
 */
export class ObjectKeyDerivationError extends Error {
  public readonly code = 'INVALID_OBJECT_KEY_INPUT';
  public readonly statusHint = 400 as const;

  constructor(field: 'workspaceId' | 'objectId') {
    // Intentionally generic — does NOT include the offending value.
    super(`Object-key derivation input "${field}" must be a UUID`);
    this.name = 'ObjectKeyDerivationError';
  }
}

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
  if (typeof input.workspaceId !== 'string' || !UUID_SHAPE.test(input.workspaceId)) {
    throw new ObjectKeyDerivationError('workspaceId');
  }
  if (typeof input.objectId !== 'string' || !UUID_SHAPE.test(input.objectId)) {
    throw new ObjectKeyDerivationError('objectId');
  }
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
