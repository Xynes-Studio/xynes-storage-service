/**
 * STORAGE-6 — opaque list cursor codec.
 *
 * The list endpoint pages via a `{ lastCreatedAt, lastId }` keyset cursor.
 * Encoding is base64url(JSON). Cursors are scoped at the repository layer
 * to the caller's workspace — a tampered cursor cannot cross workspaces
 * because the repo only ever filters within `workspaceId`. We still
 * defensively validate the decoded shape so malformed inputs surface as
 * `400 VALIDATION_ERROR` instead of crashing the repo.
 *
 * Cursors deliberately do NOT carry the workspace id — that would leak
 * the value of `workspaceId` if a cursor ended up in a log line (the
 * Task 6 redaction does not pre-emptively scrub base64).
 */

export interface ListCursor {
  /** ISO-8601 timestamp of the last returned row. */
  readonly lastCreatedAt: string;
  /** UUID of the last returned row (tiebreaker for identical timestamps). */
  readonly lastId: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function encodeListCursor(cursor: ListCursor): string {
  const json = JSON.stringify({ c: cursor.lastCreatedAt, i: cursor.lastId });
  return Buffer.from(json, 'utf8').toString('base64url');
}

/**
 * Decode + validate. Throws `InvalidCursorError` on any tampering /
 * truncation / shape mismatch. Returns `null` for `null` / `undefined`
 * / empty string so handlers can pass the raw value through.
 */
export class InvalidCursorError extends Error {
  public readonly code = 'INVALID_CURSOR';
  public readonly statusHint = 400 as const;
  constructor() {
    // Generic message — does NOT echo the malformed cursor.
    super('Cursor is invalid');
    this.name = 'InvalidCursorError';
  }
}

export function decodeListCursor(cursor: string | null | undefined): ListCursor | null {
  if (cursor === null || cursor === undefined || cursor === '') return null;
  if (typeof cursor !== 'string') throw new InvalidCursorError();
  let json: string;
  try {
    json = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new InvalidCursorError();
  }
  // Empty buffer parses to empty string — reject.
  if (json.length === 0) throw new InvalidCursorError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new InvalidCursorError();
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { c: unknown }).c !== 'string' ||
    typeof (parsed as { i: unknown }).i !== 'string'
  ) {
    throw new InvalidCursorError();
  }
  const c = (parsed as { c: string; i: string }).c;
  const i = (parsed as { c: string; i: string }).i;
  if (!ISO.test(c)) throw new InvalidCursorError();
  if (!UUID.test(i)) throw new InvalidCursorError();
  return { lastCreatedAt: c, lastId: i };
}
