/**
 * Unit tests for the row-to-DTO mappers. No DB required.
 *
 * Coverage focuses on:
 *   - field-by-field mapping correctness for every shape
 *   - column-name divergence (`variant_kind` → `variantKey`, etc.)
 *   - `required` derivation per `jobType`
 *   - defensive defaults (unknown job type → required=true)
 *   - bigint → number coercion
 *   - non-leakage of provider material (no spread of row).
 */
import { describe, expect, test } from 'bun:test';
import {
  mapStorageObjectRow,
  mapUploadSessionRow,
  mapVariantRow,
  mapProcessingJobRow,
  mapUsageRow,
  deriveJobRequired,
} from '../../../../src/infra/db/repositories/mappers';
import type {
  StorageObjectRow,
  StorageUploadSessionRow,
  StorageObjectVariantRow,
  StorageProcessingJobRow,
} from '../../../../src/infra/db';
import type { UsageRowWithProviderKind } from '../../../../src/infra/db/repositories/mappers';

const NOW = new Date('2026-05-15T12:00:00.000Z');

function objectRow(overrides: Partial<StorageObjectRow> = {}): StorageObjectRow {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    workspaceId: '00000000-0000-4000-8000-000000000010',
    providerId: '00000000-0000-4000-8000-000000000020',
    providerObjectKey: 'workspaces/ws/objects/obj/file.png',
    filename: 'file.png',
    contentType: 'image/png',
    byteSize: 12345n,
    sha256: null,
    purpose: 'cms_media',
    visibility: 'private',
    status: 'uploaded',
    compressionRequested: true,
    createdBy: '00000000-0000-4000-8000-000000000030',
    createdAt: NOW,
    updatedAt: NOW,
    uploadedAt: NOW,
    readyAt: null,
    deletedAt: null,
    failureCode: null,
    failureMessage: null,
    ...overrides,
  } as StorageObjectRow;
}

describe('mapStorageObjectRow', () => {
  test('maps every public field explicitly', () => {
    const dto = mapStorageObjectRow(objectRow());
    expect(dto.id).toBe('00000000-0000-4000-8000-000000000001');
    expect(dto.workspaceId).toBe('00000000-0000-4000-8000-000000000010');
    expect(dto.providerId).toBe('00000000-0000-4000-8000-000000000020');
    expect(dto.providerObjectKey).toBe('workspaces/ws/objects/obj/file.png');
    expect(dto.filename).toBe('file.png');
    expect(dto.contentType).toBe('image/png');
    expect(dto.byteSize).toBe(12345);
    expect(dto.sha256).toBeNull();
    expect(dto.purpose).toBe('cms_media');
    expect(dto.visibility).toBe('private');
    expect(dto.status).toBe('uploaded');
    expect(dto.compressionRequested).toBe(true);
    expect(dto.createdBy).toBe('00000000-0000-4000-8000-000000000030');
    expect(dto.createdAt).toBe(NOW);
    expect(dto.updatedAt).toBe(NOW);
    expect(dto.uploadedAt).toBe(NOW);
  });

  test('coerces bigint byteSize to number', () => {
    const dto = mapStorageObjectRow(objectRow({ byteSize: 9_999_999n }));
    expect(typeof dto.byteSize).toBe('number');
    expect(dto.byteSize).toBe(9_999_999);
  });

  test('does NOT leak DB-only columns (readyAt, deletedAt, failureCode)', () => {
    const dto = mapStorageObjectRow(
      objectRow({
        readyAt: new Date(),
        deletedAt: new Date(),
        failureCode: 'PROCESSOR_FAILED',
        failureMessage: 'this should not leak',
      }),
    );
    const serialised = JSON.stringify(dto);
    expect(serialised).not.toContain('failureCode');
    expect(serialised).not.toContain('failureMessage');
    expect(serialised).not.toContain('readyAt');
    expect(serialised).not.toContain('deletedAt');
    expect(serialised).not.toContain('PROCESSOR_FAILED');
    expect(serialised).not.toContain('this should not leak');
  });
});

describe('mapUploadSessionRow', () => {
  test('maps every field including providerUploadId', () => {
    const row: StorageUploadSessionRow = {
      id: '00000000-0000-4000-8000-000000000040',
      workspaceId: '00000000-0000-4000-8000-000000000010',
      objectId: '00000000-0000-4000-8000-000000000001',
      uploadMethod: 'multipart',
      providerUploadId: 'PROVIDER-UPLOAD-ID',
      status: 'pending',
      createdAt: NOW,
      expiresAt: new Date('2026-05-15T13:00:00.000Z'),
      completedAt: null,
      abortedAt: null,
      createdBy: '00000000-0000-4000-8000-000000000030',
    } as StorageUploadSessionRow;
    const dto = mapUploadSessionRow(row);
    expect(dto.providerUploadId).toBe('PROVIDER-UPLOAD-ID');
    expect(dto.status).toBe('pending');
    expect(dto.uploadMethod).toBe('multipart');
    expect(dto.expiresAt.toISOString()).toBe('2026-05-15T13:00:00.000Z');
  });

  test('handles null providerUploadId for single uploads', () => {
    const dto = mapUploadSessionRow({
      id: '00000000-0000-4000-8000-000000000041',
      workspaceId: '00000000-0000-4000-8000-000000000010',
      objectId: '00000000-0000-4000-8000-000000000001',
      uploadMethod: 'single',
      providerUploadId: null,
      status: 'pending',
      createdAt: NOW,
      expiresAt: NOW,
      completedAt: null,
      abortedAt: null,
      createdBy: null,
    } as StorageUploadSessionRow);
    expect(dto.providerUploadId).toBeNull();
    expect(dto.createdBy).toBeNull();
  });
});

describe('mapVariantRow', () => {
  test('maps variant_kind → variantKey', () => {
    const row: StorageObjectVariantRow = {
      id: '00000000-0000-4000-8000-000000000050',
      objectId: '00000000-0000-4000-8000-000000000001',
      variantKind: 'image-1024',
      providerObjectKey: 'workspaces/ws/objects/obj/variants/image-1024.webp',
      contentType: 'image/webp',
      byteSize: 8_000n,
      width: 1024,
      height: 768,
      durationMs: null,
      status: 'ready',
      createdAt: NOW,
      readyAt: new Date('2026-05-15T12:30:00.000Z'),
    } as StorageObjectVariantRow;
    const dto = mapVariantRow(row);
    expect(dto.variantKey).toBe('image-1024');
    expect(dto.contentType).toBe('image/webp');
    expect(dto.byteSize).toBe(8_000);
    expect(dto.status).toBe('ready');
    expect(dto.updatedAt.toISOString()).toBe('2026-05-15T12:30:00.000Z');
  });

  test('derives updatedAt = createdAt when readyAt is null', () => {
    const dto = mapVariantRow({
      id: '00000000-0000-4000-8000-000000000051',
      objectId: '00000000-0000-4000-8000-000000000001',
      variantKind: 'pending-thumb',
      providerObjectKey: 'x',
      contentType: 'image/webp',
      byteSize: 1n,
      width: null,
      height: null,
      durationMs: null,
      status: 'pending',
      createdAt: NOW,
      readyAt: null,
    } as StorageObjectVariantRow);
    expect(dto.updatedAt).toBe(NOW);
  });

  test('does NOT leak providerObjectKey', () => {
    const dto = mapVariantRow({
      id: '00000000-0000-4000-8000-000000000052',
      objectId: '00000000-0000-4000-8000-000000000001',
      variantKind: 'image-256',
      providerObjectKey: 'SECRET/path/that/must/never/leak.webp',
      contentType: 'image/webp',
      byteSize: 1n,
      width: null,
      height: null,
      durationMs: null,
      status: 'ready',
      createdAt: NOW,
      readyAt: NOW,
    } as StorageObjectVariantRow);
    const serialised = JSON.stringify(dto);
    expect(serialised).not.toContain('SECRET/path');
  });
});

describe('mapProcessingJobRow + deriveJobRequired', () => {
  test('maps job_kind → jobType and derives required for scan_validation', () => {
    const row: StorageProcessingJobRow = {
      id: '00000000-0000-4000-8000-000000000060',
      objectId: '00000000-0000-4000-8000-000000000001',
      workspaceId: '00000000-0000-4000-8000-000000000010',
      jobKind: 'scan_validation',
      status: 'queued',
      attempts: 0,
      scheduledAt: NOW,
      startedAt: null,
      finishedAt: null,
      errorCode: null,
      errorMessage: null,
      createdAt: NOW,
    } as StorageProcessingJobRow;
    const dto = mapProcessingJobRow(row);
    expect(dto.jobType).toBe('scan_validation');
    expect(dto.required).toBe(true);
    expect(dto.attempts).toBe(0);
    expect(dto.errorCode).toBeNull();
    expect(dto.updatedAt).toBe(NOW); // no started/finished, falls back to createdAt
  });

  test('derives required=false for best-effort jobs', () => {
    expect(deriveJobRequired('image_optimize')).toBe(false);
    expect(deriveJobRequired('video_thumbnail')).toBe(false);
    expect(deriveJobRequired('video_transcode')).toBe(false);
    expect(deriveJobRequired('document_preview')).toBe(false);
  });

  test('derives required=true for required jobs', () => {
    expect(deriveJobRequired('scan_validation')).toBe(true);
    expect(deriveJobRequired('video_probe')).toBe(true);
  });

  test('fail-closed for unknown job types — defaults required=true', () => {
    expect(deriveJobRequired('unknown_job_kind')).toBe(true);
    expect(deriveJobRequired('')).toBe(true);
  });

  test('updatedAt prefers finishedAt over startedAt over createdAt', () => {
    const finishedAt = new Date('2026-05-15T12:10:00.000Z');
    const startedAt = new Date('2026-05-15T12:05:00.000Z');
    const dtoFinished = mapProcessingJobRow({
      id: 'x',
      objectId: 'y',
      workspaceId: 'z',
      jobKind: 'image_optimize',
      status: 'succeeded',
      attempts: 1,
      scheduledAt: NOW,
      startedAt,
      finishedAt,
      errorCode: null,
      errorMessage: null,
      createdAt: NOW,
    } as StorageProcessingJobRow);
    expect(dtoFinished.updatedAt).toBe(finishedAt);

    const dtoStarted = mapProcessingJobRow({
      id: 'x',
      objectId: 'y',
      workspaceId: 'z',
      jobKind: 'image_optimize',
      status: 'running',
      attempts: 1,
      scheduledAt: NOW,
      startedAt,
      finishedAt: null,
      errorCode: null,
      errorMessage: null,
      createdAt: NOW,
    } as StorageProcessingJobRow);
    expect(dtoStarted.updatedAt).toBe(startedAt);
  });

  test('does NOT leak errorMessage (only errorCode is public)', () => {
    const dto = mapProcessingJobRow({
      id: 'x',
      objectId: 'y',
      workspaceId: 'z',
      jobKind: 'image_optimize',
      status: 'failed',
      attempts: 3,
      scheduledAt: NOW,
      startedAt: NOW,
      finishedAt: NOW,
      errorCode: 'PROCESSOR_FAILED',
      errorMessage: 'sharp: input file contains unsupported image format',
      createdAt: NOW,
    } as StorageProcessingJobRow);
    expect(dto.errorCode).toBe('PROCESSOR_FAILED');
    const serialised = JSON.stringify(dto);
    expect(serialised).not.toContain('sharp:');
    expect(serialised).not.toContain('unsupported image format');
  });
});

describe('mapUsageRow', () => {
  test('coerces bigints to numbers and preserves date string', () => {
    const row: UsageRowWithProviderKind = {
      id: 'x',
      workspaceId: 'ws',
      providerId: 'pid',
      usageDate: '2026-05-15',
      bytesStored: 1_000_000n,
      bytesEgress: 2_000_000n,
      operationsClassA: 10n,
      operationsClassB: 20n,
      objectCount: 5n,
      createdAt: NOW,
      updatedAt: NOW,
      providerKind: 'r2',
    } as UsageRowWithProviderKind;
    const dto = mapUsageRow(row);
    expect(dto.date).toBe('2026-05-15');
    expect(dto.bytesStored).toBe(1_000_000);
    expect(dto.bytesEgress).toBe(2_000_000);
    expect(dto.classAOperations).toBe(10);
    expect(dto.classBOperations).toBe(20);
    expect(dto.providerKind).toBe('r2');
  });

  test('handles null providerKind (workspace-wide aggregate row)', () => {
    const dto = mapUsageRow({
      id: 'x',
      workspaceId: 'ws',
      providerId: null,
      usageDate: '2026-05-15',
      bytesStored: 0n,
      bytesEgress: 0n,
      operationsClassA: 0n,
      operationsClassB: 0n,
      objectCount: 0n,
      createdAt: NOW,
      updatedAt: NOW,
      providerKind: null,
    } as UsageRowWithProviderKind);
    expect(dto.providerKind).toBeNull();
  });

  test('handles Date-typed usageDate (Drizzle date column quirk)', () => {
    const dto = mapUsageRow({
      id: 'x',
      workspaceId: 'ws',
      providerId: null,
      // Some drivers return `Date` for `date` columns.
      usageDate: new Date('2026-05-15T00:00:00.000Z') as unknown as string,
      bytesStored: 0n,
      bytesEgress: 0n,
      operationsClassA: 0n,
      operationsClassB: 0n,
      objectCount: 0n,
      createdAt: NOW,
      updatedAt: NOW,
      providerKind: null,
    } as UsageRowWithProviderKind);
    // Coerced to string; we don't constrain the exact format
    // (locales vary). Just assert it is a string and contains the
    // expected date pieces.
    expect(typeof dto.date).toBe('string');
    expect(dto.date).toContain('2026');
  });
});
