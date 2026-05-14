/**
 * STORAGE-6 — schemas + classifier tests.
 *
 * Covers:
 *   - Discriminator routing (strict-parse rejects unknown ops).
 *   - Filter validators (purpose snake_case, status whitelist, family enum).
 *   - Pagination bounds (limit ∈ [1, 200], cursor length ≤ 512).
 *   - Download-URL filename header-injection guard (no CR/LF/quote).
 *   - Download-URL TTL bounds (30 s ≤ ttl ≤ 1 h).
 *   - Usage date shape (strict YYYY-MM-DD).
 *   - `classifyContentType` mapping invariants.
 */
import { describe, expect, test } from 'bun:test';
import {
  CONTENT_TYPE_FAMILIES,
  DEFAULT_DOWNLOAD_URL_TTL_SECONDS,
  DEFAULT_LIST_LIMIT,
  MAX_DOWNLOAD_URL_TTL_SECONDS,
  MAX_LIST_LIMIT,
  MAX_USAGE_RANGE_DAYS,
  MIN_DOWNLOAD_URL_TTL_SECONDS,
  PUBLIC_OBJECT_STATUSES,
  classifyContentType,
  createDownloadUrlPayloadSchema,
  deleteObjectPayloadSchema,
  getObjectPayloadSchema,
  listObjectsPayloadSchema,
  usageReadPayloadSchema,
} from '../../../../src/actions/handlers/objects/schemas';

describe('schemas — list', () => {
  test('accepts a minimal valid payload', () => {
    const r = listObjectsPayloadSchema.safeParse({ operation: 'list' });
    expect(r.success).toBe(true);
  });

  test('rejects unknown fields (strict)', () => {
    const r = listObjectsPayloadSchema.safeParse({ operation: 'list', extra: true });
    expect(r.success).toBe(false);
  });

  test('rejects unknown filter fields (strict)', () => {
    const r = listObjectsPayloadSchema.safeParse({
      operation: 'list',
      filters: { hostile: 1 },
    });
    expect(r.success).toBe(false);
  });

  test('rejects non-snake_case purpose', () => {
    const r = listObjectsPayloadSchema.safeParse({
      operation: 'list',
      filters: { purpose: 'CMS_MEDIA' },
    });
    expect(r.success).toBe(false);
  });

  test('rejects non-whitelisted status', () => {
    const r = listObjectsPayloadSchema.safeParse({
      operation: 'list',
      filters: { status: 'deleted' },
    });
    expect(r.success).toBe(false);
  });

  test('rejects limit > MAX_LIST_LIMIT', () => {
    const r = listObjectsPayloadSchema.safeParse({
      operation: 'list',
      limit: MAX_LIST_LIMIT + 1,
    });
    expect(r.success).toBe(false);
  });

  test('rejects limit < 1', () => {
    const r = listObjectsPayloadSchema.safeParse({ operation: 'list', limit: 0 });
    expect(r.success).toBe(false);
  });

  test('rejects cursor over 512 chars', () => {
    const r = listObjectsPayloadSchema.safeParse({
      operation: 'list',
      cursor: 'x'.repeat(513),
    });
    expect(r.success).toBe(false);
  });

  test('rejects non-ISO createdAfter', () => {
    const r = listObjectsPayloadSchema.safeParse({
      operation: 'list',
      filters: { createdAfter: 'yesterday' },
    });
    expect(r.success).toBe(false);
  });

  test('rejects non-UUID createdBy', () => {
    const r = listObjectsPayloadSchema.safeParse({
      operation: 'list',
      filters: { createdBy: 'someone' },
    });
    expect(r.success).toBe(false);
  });

  test('accepts all PUBLIC_OBJECT_STATUSES', () => {
    for (const s of PUBLIC_OBJECT_STATUSES) {
      const r = listObjectsPayloadSchema.safeParse({
        operation: 'list',
        filters: { status: s },
      });
      expect(r.success).toBe(true);
    }
  });

  test('DEFAULT_LIST_LIMIT is within bounds', () => {
    expect(DEFAULT_LIST_LIMIT).toBeGreaterThan(0);
    expect(DEFAULT_LIST_LIMIT).toBeLessThanOrEqual(MAX_LIST_LIMIT);
  });
});

describe('schemas — get', () => {
  test('requires UUID objectId', () => {
    expect(getObjectPayloadSchema.safeParse({ operation: 'get', objectId: 'abc' }).success).toBe(
      false,
    );
  });

  test('accepts valid UUID objectId', () => {
    expect(
      getObjectPayloadSchema.safeParse({
        operation: 'get',
        objectId: '00000000-0000-4000-8000-000000000001',
      }).success,
    ).toBe(true);
  });

  test('rejects unknown fields', () => {
    expect(
      getObjectPayloadSchema.safeParse({
        operation: 'get',
        objectId: '00000000-0000-4000-8000-000000000001',
        extra: true,
      }).success,
    ).toBe(false);
  });
});

describe('schemas — download_url', () => {
  const validId = '00000000-0000-4000-8000-000000000002';

  test('happy path', () => {
    expect(
      createDownloadUrlPayloadSchema.safeParse({
        operation: 'download_url',
        objectId: validId,
      }).success,
    ).toBe(true);
  });

  test('rejects ttl < MIN_DOWNLOAD_URL_TTL_SECONDS', () => {
    expect(
      createDownloadUrlPayloadSchema.safeParse({
        operation: 'download_url',
        objectId: validId,
        expiresInSeconds: MIN_DOWNLOAD_URL_TTL_SECONDS - 1,
      }).success,
    ).toBe(false);
  });

  test('rejects ttl > MAX_DOWNLOAD_URL_TTL_SECONDS', () => {
    expect(
      createDownloadUrlPayloadSchema.safeParse({
        operation: 'download_url',
        objectId: validId,
        expiresInSeconds: MAX_DOWNLOAD_URL_TTL_SECONDS + 1,
      }).success,
    ).toBe(false);
  });

  test('rejects CRLF in downloadFilename (header injection guard)', () => {
    expect(
      createDownloadUrlPayloadSchema.safeParse({
        operation: 'download_url',
        objectId: validId,
        downloadFilename: 'evil\r\nX-Header: 1',
      }).success,
    ).toBe(false);
  });

  test('rejects quote chars in downloadFilename', () => {
    expect(
      createDownloadUrlPayloadSchema.safeParse({
        operation: 'download_url',
        objectId: validId,
        downloadFilename: 'evil"hack',
      }).success,
    ).toBe(false);
  });

  test('rejects empty downloadFilename', () => {
    expect(
      createDownloadUrlPayloadSchema.safeParse({
        operation: 'download_url',
        objectId: validId,
        downloadFilename: '',
      }).success,
    ).toBe(false);
  });

  test('accepts boundary ttl values', () => {
    expect(
      createDownloadUrlPayloadSchema.safeParse({
        operation: 'download_url',
        objectId: validId,
        expiresInSeconds: MIN_DOWNLOAD_URL_TTL_SECONDS,
      }).success,
    ).toBe(true);
    expect(
      createDownloadUrlPayloadSchema.safeParse({
        operation: 'download_url',
        objectId: validId,
        expiresInSeconds: MAX_DOWNLOAD_URL_TTL_SECONDS,
      }).success,
    ).toBe(true);
  });

  test('DEFAULT_DOWNLOAD_URL_TTL_SECONDS is within bounds', () => {
    expect(DEFAULT_DOWNLOAD_URL_TTL_SECONDS).toBeGreaterThanOrEqual(MIN_DOWNLOAD_URL_TTL_SECONDS);
    expect(DEFAULT_DOWNLOAD_URL_TTL_SECONDS).toBeLessThanOrEqual(MAX_DOWNLOAD_URL_TTL_SECONDS);
  });
});

describe('schemas — delete', () => {
  test('requires UUID', () => {
    expect(
      deleteObjectPayloadSchema.safeParse({ operation: 'delete', objectId: 'x' }).success,
    ).toBe(false);
  });

  test('rejects unknown fields', () => {
    expect(
      deleteObjectPayloadSchema.safeParse({
        operation: 'delete',
        objectId: '00000000-0000-4000-8000-000000000003',
        cascade: true,
      }).success,
    ).toBe(false);
  });
});

describe('schemas — usage', () => {
  test('accepts empty payload', () => {
    expect(usageReadPayloadSchema.safeParse({ operation: 'usage' }).success).toBe(true);
  });

  test('rejects non-date strings', () => {
    expect(
      usageReadPayloadSchema.safeParse({ operation: 'usage', from: '2026/05/01' }).success,
    ).toBe(false);
    expect(usageReadPayloadSchema.safeParse({ operation: 'usage', from: '5-1-2026' }).success).toBe(
      false,
    );
  });

  test('accepts YYYY-MM-DD shape', () => {
    expect(
      usageReadPayloadSchema.safeParse({ operation: 'usage', from: '2026-05-01', to: '2026-05-13' })
        .success,
    ).toBe(true);
  });

  test('rejects unknown fields', () => {
    expect(
      usageReadPayloadSchema.safeParse({ operation: 'usage', granularity: 'hour' }).success,
    ).toBe(false);
  });

  test('MAX_USAGE_RANGE_DAYS is a sane bound', () => {
    expect(MAX_USAGE_RANGE_DAYS).toBe(366);
  });
});

describe('classifyContentType', () => {
  test('classifies common image types', () => {
    expect(classifyContentType('image/jpeg')).toBe('image');
    expect(classifyContentType('image/png')).toBe('image');
    expect(classifyContentType('image/webp')).toBe('image');
    expect(classifyContentType('IMAGE/JPEG')).toBe('image'); // case-insensitive
  });

  test('classifies video / audio / text', () => {
    expect(classifyContentType('video/mp4')).toBe('video');
    expect(classifyContentType('audio/mpeg')).toBe('audio');
    expect(classifyContentType('text/plain')).toBe('text');
  });

  test('classifies documents', () => {
    expect(classifyContentType('application/pdf')).toBe('document');
    expect(
      classifyContentType(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
    ).toBe('document');
    expect(classifyContentType('application/msword')).toBe('document');
  });

  test('classifies archives', () => {
    expect(classifyContentType('application/zip')).toBe('archive');
    expect(classifyContentType('application/gzip')).toBe('archive');
  });

  test('falls through to other for unknown / hostile', () => {
    expect(classifyContentType('')).toBe('other');
    expect(classifyContentType('garbage')).toBe('other');
    expect(classifyContentType('application/octet-stream')).toBe('other');
    expect(classifyContentType(undefined as unknown as string)).toBe('other');
  });

  test('CONTENT_TYPE_FAMILIES list is exhaustive', () => {
    expect(CONTENT_TYPE_FAMILIES).toEqual([
      'image',
      'video',
      'audio',
      'document',
      'archive',
      'text',
      'other',
    ]);
  });
});
