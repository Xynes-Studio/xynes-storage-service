/**
 * STORAGE-FU-2-FU-4 — unit tests for the `CONTENT_TYPE_FAMILY_PREFIXES`
 * constant + the prefix-parity invariant.
 *
 * These tests run without a DB connection. They lock in the contract:
 *
 *   1. The constant's keys are exactly the closed set of content-type
 *      families minus 'other' (so `Object.keys(CONTENT_TYPE_FAMILY_PREFIXES)
 *      ⊕ ['other']` equals `CONTENT_TYPE_FAMILIES`).
 *   2. The union of all per-family prefix arrays is BYTE-FOR-BYTE
 *      identical to the historical hardcoded list used by the
 *      pre-FU-4 'other' branch (regression guard against a silent drift
 *      where a new family is added but the 'other' exclusion is not).
 *   3. The outer constant + every inner array are frozen
 *      (`Object.freeze`) so a hostile caller cannot mutate the prefix
 *      set at runtime.
 *
 * Behavioural equivalence of the 'other' branch SQL clause is covered
 * separately by the `contentTypeFamily=other excludes every known
 * prefix` integration test in `object-and-session-repository.test.ts`
 * — that test runs against real Postgres and is the live behavioural
 * lock. THESE tests assert the structural invariants the rewrite
 * depends on.
 */
import { describe, expect, test } from 'bun:test';
import { CONTENT_TYPE_FAMILY_PREFIXES } from '../../../../src/infra/db/repositories/object-and-session-repository';
import { CONTENT_TYPE_FAMILIES } from '../../../../src/actions/handlers/objects/schemas';

/**
 * Historical hardcoded list from the pre-FU-4 inline
 * `NOT (... LIKE ...)` clause inside `listForWorkspace`. Order matters
 * for the byte-for-byte equality assertion below: the rewrite preserves
 * the per-family iteration order (image → video → audio → text →
 * archive → document), and within each family the array order is
 * preserved.
 *
 * If a new content-type family is added to `CONTENT_TYPE_FAMILY_PREFIXES`
 * this fixture MUST be updated to match — the parity test below will
 * fail until both lists agree.
 */
const HISTORICAL_HARDCODED_PREFIXES = [
  'image/',
  'video/',
  'audio/',
  'text/',
  'application/zip',
  'application/x-tar',
  'application/x-7z-compressed',
  'application/x-rar',
  'application/gzip',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument',
  'application/vnd.oasis.opendocument',
  'application/rtf',
] as const;

describe('STORAGE-FU-2-FU-4 — CONTENT_TYPE_FAMILY_PREFIXES', () => {
  describe('closed-set parity with CONTENT_TYPE_FAMILIES', () => {
    test('keys + "other" = CONTENT_TYPE_FAMILIES (closed set)', () => {
      const constantKeys = Object.keys(CONTENT_TYPE_FAMILY_PREFIXES).sort();
      const familiesMinusOther = [...CONTENT_TYPE_FAMILIES].filter((f) => f !== 'other').sort();
      expect(constantKeys).toEqual(familiesMinusOther);
    });

    test('does not declare a prefix list for "other"', () => {
      // 'other' is structurally the absence of any known prefix.
      // Declaring a prefix array for it would be a contradiction.
      expect(Object.keys(CONTENT_TYPE_FAMILY_PREFIXES)).not.toContain('other');
    });

    test('every family has at least one prefix', () => {
      for (const [family, prefixes] of Object.entries(CONTENT_TYPE_FAMILY_PREFIXES)) {
        expect(prefixes.length).toBeGreaterThan(0);
        // Defense in depth: a future agent adding a family with an
        // empty array would silently break the 'other' branch's
        // exclusion logic.
        expect(prefixes.every((p) => typeof p === 'string' && p.length > 0)).toBe(true);
        // The leading slash on `image/` etc. is significant — it
        // makes the LIKE clause match `image/png` but not
        // `image-malicious/foo`. Spot-check the historical posture
        // holds (the family-level check that this is meaningful
        // lives in the parity test below).
        expect(family.length).toBeGreaterThan(0);
      }
    });
  });

  describe('union-of-prefixes parity with the pre-FU-4 hardcoded list', () => {
    test('flat union is byte-for-byte identical to the historical list', () => {
      const union = (
        Object.values(CONTENT_TYPE_FAMILY_PREFIXES) as readonly (readonly string[])[]
      ).flatMap((p) => [...p]);
      // EXACT equality (order included). The pre-FU-4 inline clause
      // had a specific iteration order; preserving it makes the
      // EXPLAIN ANALYZE plan identical pre-/post-refactor.
      expect(union).toEqual([...HISTORICAL_HARDCODED_PREFIXES]);
    });

    test('union covers every documented MIME family', () => {
      // Per-family spot checks against the documented contract in
      // `schemas.classifyContentType`. If a future agent removes a
      // family from the constant by accident, this fails loud.
      const union = (
        Object.values(CONTENT_TYPE_FAMILY_PREFIXES) as readonly (readonly string[])[]
      ).flatMap((p) => [...p]);
      expect(union).toContain('image/');
      expect(union).toContain('video/');
      expect(union).toContain('audio/');
      expect(union).toContain('text/');
      expect(union).toContain('application/pdf');
      expect(union).toContain('application/msword');
      expect(union).toContain('application/vnd.openxmlformats-officedocument');
      expect(union).toContain('application/vnd.oasis.opendocument');
      expect(union).toContain('application/rtf');
      expect(union).toContain('application/zip');
      expect(union).toContain('application/x-tar');
      expect(union).toContain('application/x-7z-compressed');
      expect(union).toContain('application/x-rar');
      expect(union).toContain('application/gzip');
    });
  });

  describe('frozen-array invariant', () => {
    test('outer record is frozen', () => {
      expect(Object.isFrozen(CONTENT_TYPE_FAMILY_PREFIXES)).toBe(true);
    });

    test('every per-family array is frozen', () => {
      for (const prefixes of Object.values(CONTENT_TYPE_FAMILY_PREFIXES)) {
        expect(Object.isFrozen(prefixes)).toBe(true);
      }
    });

    test('attempt to mutate the outer record is rejected in strict mode', () => {
      // Bun runs ESM in strict mode; assigning to a frozen object throws.
      // Use a function expression so the throw is caught inside `expect`.
      expect(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (CONTENT_TYPE_FAMILY_PREFIXES as any).attackerFamily = ['evil/'];
      }).toThrow();
    });

    test('attempt to mutate an inner prefix array is rejected in strict mode', () => {
      expect(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (CONTENT_TYPE_FAMILY_PREFIXES.image as any).push('attacker-controlled/');
      }).toThrow();
    });
  });
});
