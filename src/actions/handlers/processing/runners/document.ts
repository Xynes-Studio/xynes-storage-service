/**
 * STORAGE-8 — document-preview runner.
 *
 * Generates a first-page preview image for documents on the safe-MIME
 * allowlist (`SAFE_DOCUMENT_PREVIEW_MIMES`). Per STORAGE-8 acceptance
 * criteria:
 *   - Do NOT lossy-compress the original document.
 *   - Generate previews ONLY for safe file types.
 *   - Treat unknown binary files as "original only after malware scan"
 *     — the planner already encodes this by NOT emitting a
 *     `document_preview` job for those.
 *
 * Defense in depth: even though STORAGE-7's planner ALREADY filters
 * out non-safe MIMEs, the runner re-checks the allowlist before
 * invoking the processor. A misconfigured queue row (e.g. a future
 * "force re-process" admin path) cannot trigger document preview
 * generation against, say, a `.zip`.
 *
 * Non-required job. The preview's content type is always PNG or JPEG
 * — never the original document format.
 */
import type { JobRunner, JobRunResult } from '../types';
import { RunnerExecutionError, RunnerInputError } from './errors';
import { isSafeDocumentPreviewMime, MAX_DOCUMENT_BYTES } from './profiles';
import type { DocumentProcessor, ProviderObjectIO, StorageVariantWriter } from './ports';
import { runRunnerWithErrorMapping } from './runner-utils';
import { deriveVariantObjectKey } from './variant-keys';

export interface DocumentPreviewRunnerDependencies {
  readonly providerIO: ProviderObjectIO;
  readonly processor: DocumentProcessor;
  readonly variants: StorageVariantWriter;
}

export function createDocumentPreviewRunner(deps: DocumentPreviewRunnerDependencies): JobRunner {
  return async ({ object }): Promise<JobRunResult | void> => {
    return runRunnerWithErrorMapping(async () => {
      if (!isSafeDocumentPreviewMime(object.contentType)) {
        throw new RunnerInputError('UNSUPPORTED_FORMAT');
      }
      if (object.byteSize > MAX_DOCUMENT_BYTES) {
        throw new RunnerInputError('OVER_MAX_BYTES');
      }

      let bytes: Uint8Array;
      try {
        bytes = await deps.providerIO.readObject({ objectKey: object.providerObjectKey });
      } catch {
        throw new RunnerExecutionError('PROCESSOR_FAILED', { retryable: true });
      }

      let render;
      try {
        render = await deps.processor.renderFirstPagePreview({
          bytes,
          sourceContentType: object.contentType,
        });
      } catch {
        throw new RunnerExecutionError('PROCESSOR_FAILED', { retryable: true });
      }

      const variantKey = deriveVariantObjectKey({
        parentObjectKey: object.providerObjectKey,
        role: 'preview_first_page',
        contentType: render.contentType,
      });

      let written;
      try {
        written = await deps.providerIO.writeObject({
          objectKey: variantKey,
          body: render.bytes,
          contentType: render.contentType,
          ifAbsent: true,
        });
      } catch {
        throw new RunnerExecutionError('PROCESSOR_FAILED', { retryable: true });
      }

      await deps.variants.recordVariant({
        objectId: object.id,
        workspaceId: object.workspaceId,
        role: 'preview_first_page',
        providerObjectKey: variantKey,
        contentType: render.contentType,
        byteSize: written.byteSize,
        width: render.width,
        height: render.height,
      });

      return {};
    });
  };
}
