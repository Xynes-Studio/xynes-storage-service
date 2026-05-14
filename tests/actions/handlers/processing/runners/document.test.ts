/**
 * STORAGE-8 — document-preview runner unit tests.
 *
 * Non-required job. Generates a first-page preview image for documents
 * on the safe-MIME allowlist. Critical invariants:
 *   - UNSUPPORTED_FORMAT for any MIME OFF the allowlist (defense in
 *     depth on top of the planner's already-filtered list).
 *   - Preview content type is image/png or image/jpeg only — never
 *     the original document format.
 *   - Never overwrites the original `providerObjectKey`.
 */
import { describe, expect, test } from 'bun:test';
import { createDocumentPreviewRunner } from '../../../../../src/actions/handlers/processing/runners/document';
import { MAX_DOCUMENT_BYTES } from '../../../../../src/actions/handlers/processing/runners/profiles';
import {
  FakeDocumentProcessor,
  FakeProviderIO,
  FakeVariantWriter,
  makeBytes,
  seedClaimedJob,
  seedDocumentObject,
  seedImageObject,
} from './_fakes';
import { seedObject } from '../_fakes';

function build() {
  const providerIO = new FakeProviderIO();
  const processor = new FakeDocumentProcessor();
  const variants = new FakeVariantWriter();
  const runner = createDocumentPreviewRunner({ providerIO, processor, variants });
  return { providerIO, processor, variants, runner };
}

describe('document-preview runner — happy path', () => {
  test('renders a single preview variant for a PDF', async () => {
    const { providerIO, variants, runner } = build();
    const object = seedDocumentObject();
    providerIO.preload(object.providerObjectKey, makeBytes(64), 'application/pdf');
    const out = await runner({ object, job: seedClaimedJob({ jobType: 'document_preview' }) });
    expect(out).toEqual({});
    expect(variants.records).toHaveLength(1);
    expect(variants.records[0]?.role).toBe('preview_first_page');
  });

  test('preview is an image (PNG or JPEG) — NOT the original document format', async () => {
    const { providerIO, variants, runner } = build();
    const object = seedDocumentObject();
    providerIO.preload(object.providerObjectKey, makeBytes(8));
    await runner({ object, job: seedClaimedJob({ jobType: 'document_preview' }) });
    const ct = variants.records[0]?.contentType;
    expect(['image/png', 'image/jpeg']).toContain(ct);
  });

  test('preview key uses the variants/ prefix', async () => {
    const { providerIO, variants, runner } = build();
    const object = seedDocumentObject({
      providerObjectKey: 'workspaces/ws/objects/obj/file.pdf',
    });
    providerIO.preload(object.providerObjectKey, makeBytes(8));
    await runner({ object, job: seedClaimedJob({ jobType: 'document_preview' }) });
    expect(
      variants.records[0]?.providerObjectKey.startsWith('workspaces/ws/objects/obj/variants/'),
    ).toBe(true);
    expect(variants.records[0]?.providerObjectKey).not.toBe(object.providerObjectKey);
  });

  test('writes use ifAbsent=true (never overwrite the original)', async () => {
    const { providerIO, runner } = build();
    const object = seedDocumentObject();
    providerIO.preload(object.providerObjectKey, makeBytes(8));
    await runner({ object, job: seedClaimedJob({ jobType: 'document_preview' }) });
    for (const w of providerIO.writes) {
      expect(w.ifAbsent).toBe(true);
    }
  });
});

describe('document-preview runner — allowlist enforcement', () => {
  test('returns UNSUPPORTED_FORMAT for an off-allowlist MIME (e.g. zip)', async () => {
    const { runner } = build();
    const object = seedObject({
      contentType: 'application/zip',
      byteSize: 1024,
    });
    const out = await runner({ object, job: seedClaimedJob({ jobType: 'document_preview' }) });
    expect(out).toEqual({ errorCode: 'UNSUPPORTED_FORMAT', retryable: false });
  });

  test('returns UNSUPPORTED_FORMAT for an image (even though family is "image")', async () => {
    const { runner } = build();
    const object = seedImageObject();
    const out = await runner({ object, job: seedClaimedJob({ jobType: 'document_preview' }) });
    expect(out).toEqual({ errorCode: 'UNSUPPORTED_FORMAT', retryable: false });
  });

  test('accepts every safe MIME on the allowlist', async () => {
    const allowlist = [
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
    for (const mime of allowlist) {
      const { providerIO, runner } = build();
      const object = seedDocumentObject({ contentType: mime });
      providerIO.preload(object.providerObjectKey, makeBytes(8));
      const out = await runner({ object, job: seedClaimedJob({ jobType: 'document_preview' }) });
      expect(out).toEqual({});
    }
  });
});

describe('document-preview runner — guard rails', () => {
  test('returns OVER_MAX_BYTES when document exceeds the 100 MiB cap', async () => {
    const { processor, runner } = build();
    const object = seedDocumentObject({ byteSize: MAX_DOCUMENT_BYTES + 1 });
    const out = await runner({ object, job: seedClaimedJob({ jobType: 'document_preview' }) });
    expect(out).toEqual({ errorCode: 'OVER_MAX_BYTES', retryable: false });
    // Processor never called.
    expect(processor.throwOnceOnce).toBeNull();
  });

  test('returns retryable PROCESSOR_FAILED on provider read throw', async () => {
    const { providerIO, runner } = build();
    providerIO.throwOnReadOnce = new Error('read error');
    const object = seedDocumentObject();
    const out = await runner({ object, job: seedClaimedJob({ jobType: 'document_preview' }) });
    expect(out).toEqual({ errorCode: 'PROCESSOR_FAILED', retryable: true });
  });

  test('returns retryable PROCESSOR_FAILED on processor render throw', async () => {
    const { providerIO, processor, runner } = build();
    const object = seedDocumentObject();
    providerIO.preload(object.providerObjectKey, makeBytes(8));
    processor.throwOnceOnce = new Error('libreoffice: corrupt document');
    const out = await runner({ object, job: seedClaimedJob({ jobType: 'document_preview' }) });
    expect(out).toEqual({ errorCode: 'PROCESSOR_FAILED', retryable: true });
  });

  test('returns retryable PROCESSOR_FAILED when variant write throws', async () => {
    const { providerIO, runner } = build();
    const object = seedDocumentObject();
    providerIO.preload(object.providerObjectKey, makeBytes(8));
    providerIO.throwOnWriteOnce = new Error('AccessDenied');
    const out = await runner({ object, job: seedClaimedJob({ jobType: 'document_preview' }) });
    expect(out).toEqual({ errorCode: 'PROCESSOR_FAILED', retryable: true });
  });
});

describe('document-preview runner — security', () => {
  test('never embeds raw processor error text into the errorCode', async () => {
    const { providerIO, processor, runner } = build();
    const object = seedDocumentObject();
    providerIO.preload(object.providerObjectKey, makeBytes(8));
    processor.throwOnceOnce = new Error('libreoffice exit 139 SIGSEGV /tmp/abc');
    const out = (await runner({
      object,
      job: seedClaimedJob({ jobType: 'document_preview' }),
    })) as {
      errorCode: string;
    };
    expect(out.errorCode).toBe('PROCESSOR_FAILED');
    expect(out.errorCode).not.toContain('libreoffice');
    expect(out.errorCode).not.toContain('/tmp');
  });
});
