/**
 * STORAGE-FU-5-FU-F — LibreOffice `DocumentProcessor` integration suite.
 *
 * Exercises the live `LibreOfficeDocumentProcessor` (FU-5-FU-C)
 * against the committed `sample.pdf` fixture.
 *
 * The processor speaks HTTP to a sidecar (FU-G shim) per the FU-E
 * deployment posture decision. There is no in-process fallback at
 * the processor layer — the sidecar URL MUST be reachable.
 *
 * This suite uses `describeIfEnv('LIBREOFFICE_SERVICE_URL', ...)`
 * so it soft-skips when the sidecar URL is unset (clean laptop
 * without docker compose up) AND hard-fails when
 * `STORAGE_INTEGRATION_PROCESSORS_REQUIRED=1`.
 *
 * In CI, the rollout sequence is:
 *   1. `docker compose up libreoffice-sidecar`
 *   2. `LIBREOFFICE_SERVICE_URL=http://libreoffice-sidecar:8100 bun test ...`
 *
 * What the suite proves end-to-end:
 *   - `sample.pdf` round-trips through `POST /convert` to a real
 *     PNG preview > 1 KiB (Bug 1 regression guard).
 *   - The `/Title` + `/Author` + `/Creator` document Info dictionary
 *     in the source PDF does NOT survive into the preview bytes
 *     (STORAGE-9 metadata-strip invariant; soffice strips on
 *     re-encode).
 */
import { expect, test } from 'bun:test';
import { LibreOfficeDocumentProcessor } from '../../../src/infra/processors/libreoffice-document-processor';
import { describeIfEnv, loadFixture } from './_helpers';

describeIfEnv(
  'LIBREOFFICE_SERVICE_URL',
  'STORAGE-FU-5-FU-F — LibreOfficeDocumentProcessor integration suite',
  () => {
    const serviceUrl = process.env.LIBREOFFICE_SERVICE_URL!;
    const processor = new LibreOfficeDocumentProcessor({ serviceUrl });
    const FIXTURE = loadFixture('sample.pdf');

    test('renderFirstPagePreview produces a PNG > 1 KiB (Bug 1 regression guard)', async () => {
      const preview = await processor.renderFirstPagePreview({
        bytes: FIXTURE,
        sourceContentType: 'application/pdf',
      });
      // Stub-mode preview is 4 bytes (JPEG SOI+EOI markers).
      expect(preview.bytes.byteLength).toBeGreaterThan(1024);
      // FU-G shim hard-codes `image/png` as the response Content-Type.
      expect(preview.contentType).toBe('image/png');
    });

    test('preview output does NOT carry the source PDF /Title metadata (STORAGE-9 strip invariant)', async () => {
      const preview = await processor.renderFirstPagePreview({
        bytes: FIXTURE,
        sourceContentType: 'application/pdf',
      });
      // The fixture carries `/Title (STORAGE-FU-5-FU-F fixture)` in
      // its document Info dictionary. The PNG output MUST NOT carry
      // the string — soffice strips it on re-encode.
      const previewStr = new TextDecoder('utf-8', { fatal: false }).decode(preview.bytes);
      expect(previewStr).not.toContain('STORAGE-FU-5-FU-F fixture');
    });

    test('preview output does NOT carry the source PDF /Author metadata', async () => {
      const preview = await processor.renderFirstPagePreview({
        bytes: FIXTURE,
        sourceContentType: 'application/pdf',
      });
      const previewStr = new TextDecoder('utf-8', { fatal: false }).decode(preview.bytes);
      expect(previewStr).not.toContain('xynes-storage-service tests');
    });

    test('preview output does NOT carry the source PDF /Creator metadata', async () => {
      const preview = await processor.renderFirstPagePreview({
        bytes: FIXTURE,
        sourceContentType: 'application/pdf',
      });
      const previewStr = new TextDecoder('utf-8', { fatal: false }).decode(preview.bytes);
      expect(previewStr).not.toContain('_generate.ts');
    });

    test('rejects an unsafe source content type (defense in depth)', async () => {
      // The processor allowlist re-check fires BEFORE any HTTP call.
      let thrown: Error | null = null;
      try {
        await processor.renderFirstPagePreview({
          bytes: FIXTURE,
          sourceContentType: 'application/x-evil',
        });
      } catch (err) {
        thrown = err as Error;
      }
      expect(thrown).not.toBeNull();
      // The runner wraps it as UNSUPPORTED_FORMAT (non-retryable).
      expect(thrown?.message ?? '').toMatch(/UNSUPPORTED_FORMAT/);
    });
  },
);
