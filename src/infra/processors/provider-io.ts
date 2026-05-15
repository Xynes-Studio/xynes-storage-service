/**
 * STORAGE-FU-5 — server-side `ProviderObjectIO` implementation.
 *
 * Bridges the narrow `ProviderObjectIO` port (consumed by every
 * STORAGE-8 runner) to the production `StorageProviderAdapter` via
 * its server-side `getObjectBytes` / `putObjectBytes` methods.
 *
 * Routing happens per-call: each `readObject` / `writeObject` invocation
 * carries `workspaceId` (required) and `providerId` (optional) so a
 * misconfigured runner cannot accidentally read / write against the
 * wrong workspace's provider. The shim NEVER caches resolved adapters
 * — the resolver's secret-manager backend is responsible for response
 * caching where appropriate (STORAGE-FU-3 §6).
 *
 * SECURITY invariants enforced here:
 *   - Workspace + provider routing happens per-call.
 *   - Missing workspaceId is treated as a programmer error and surfaced
 *     via a generic message ("Provider routing failed"). The upstream
 *     runner's `runRunnerWithErrorMapping` translates everything into
 *     the closed-set `PROCESSOR_FAILED` retryable code before it leaves
 *     the service.
 *   - Resolver failures (including secret-manager outages) propagate
 *     as a generic `Error` — the resolver itself already redacts its
 *     own internal messages per STORAGE-FU-3. We belt-and-braces it
 *     here with a generic outer message.
 *   - Adapter SDK errors propagate as `ProviderAdapterError` with the
 *     redacted detail from `runWithRedactedError` (STORAGE-4 contract).
 *   - `ifAbsent: true` is forwarded so the adapter sets
 *     `If-None-Match: *` on the conditional PUT — defense in depth on
 *     top of the runner's variant-key collision check.
 */
import type { ProviderObjectIO } from '../../actions/handlers/processing/runners/ports';
import type { ExtendedStorageProviderResolver } from '../../actions/handlers/objects/types';
import type { ResolvedProvider } from '../../actions/handlers/uploads/types';

export const PROVIDER_IO_ROUTING_FAILED_MESSAGE = 'Provider routing failed';
export const PROVIDER_IO_NOT_FOUND_MESSAGE = 'No provider configured for workspace';

export interface S3ProviderObjectIODependencies {
  /**
   * Workspace + provider resolver. The `Extended` flavour is required
   * because runners route per-object via `providerId` (the object's
   * recorded provider) AND we want to fall back to the workspace
   * default when no `providerId` is supplied.
   */
  readonly providers: ExtendedStorageProviderResolver;
}

/**
 * Build a `ProviderObjectIO` impl backed by the resolved
 * `StorageProviderAdapter` per call. The returned object holds NO
 * mutable state — it is safe to reuse for the whole worker lifetime.
 *
 * Production: composition root constructs this with the
 * `PostgresExtendedStorageProviderResolver` from STORAGE-FU-3.
 * Tests: pass an in-memory fake resolver whose resolved
 * `ResolvedProvider.adapter` is a fake `StorageProviderAdapter`.
 */
export function createS3ProviderObjectIO(deps: S3ProviderObjectIODependencies): ProviderObjectIO {
  async function resolve(input: {
    workspaceId?: string;
    providerId?: string;
  }): Promise<ResolvedProvider> {
    if (!input.workspaceId || input.workspaceId.length === 0) {
      // Programmer error — runners MUST forward `workspaceId`.
      throw new Error(PROVIDER_IO_ROUTING_FAILED_MESSAGE);
    }
    let resolved: ResolvedProvider | null;
    try {
      if (input.providerId && input.providerId.length > 0) {
        resolved = await deps.providers.resolveByProviderIdForWorkspace({
          workspaceId: input.workspaceId,
          providerId: input.providerId,
        });
      } else {
        resolved = await deps.providers.resolveDefaultForWorkspace(input.workspaceId);
      }
    } catch {
      // The resolver itself already redacts (STORAGE-FU-3); we
      // belt-and-braces here so future alternate resolver impls cannot
      // accidentally leak.
      throw new Error(PROVIDER_IO_ROUTING_FAILED_MESSAGE);
    }
    if (!resolved) {
      throw new Error(PROVIDER_IO_NOT_FOUND_MESSAGE);
    }
    return resolved;
  }

  return {
    async readObject(input) {
      const r = await resolve(input);
      return r.adapter.getObjectBytes({ objectKey: input.objectKey });
    },
    async writeObject(input) {
      const r = await resolve(input);
      const result = await r.adapter.putObjectBytes({
        objectKey: input.objectKey,
        body: input.body,
        contentType: input.contentType,
        ifAbsent: input.ifAbsent,
      });
      return { byteSize: result.byteSize };
    },
  };
}
