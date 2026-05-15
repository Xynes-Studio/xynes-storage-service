/**
 * STORAGE-FU-3 — Postgres-backed provider resolver.
 *
 * Implements both `StorageProviderResolver` (STORAGE-5 contract: resolve
 * the workspace default) and `ExtendedStorageProviderResolver`
 * (STORAGE-6 contract: also resolve a specific provider id for the
 * workspace — needed for download URLs + deletes against the provider
 * that ACTUALLY holds the original object, not whichever provider the
 * workspace defaults to today).
 *
 * The single class implements both interfaces so the composition root
 * can register one instance and pass it to both `registerUploadActionHandlers`
 * and `registerObjectActionHandlers`.
 *
 * Security invariants (proven by tests):
 *   - Every SELECT carries `workspace_id = $ws` as the first WHERE
 *     clause. Cross-workspace `resolveByProviderIdForWorkspace` returns
 *     `null` (NOT throws — preserves the STORAGE-6 "no enumeration
 *     oracle" invariant).
 *   - Rows with `status = 'disabled'` are filtered out.
 *   - The `credential_ref` URI is consumed by the secret manager, NOT
 *     the adapter. The adapter never sees the URI; only the resolved
 *     `accessKeyId` + `secretAccessKey`.
 *   - Provider-config field allowlist: only `id`, `provider_kind`,
 *     `endpoint`, `region`, `bucket`, `display_name` (used for logs
 *     only) reach the resolver from the row. Everything else
 *     (`credential_ref`, `status`, `created_by`, `created_at`,
 *     `updated_at`, `is_default`) is consumed inside the resolver and
 *     NEVER bleeds through to the adapter or the caller.
 *   - Resolver errors NEVER carry `accessKeyId` / `secretAccessKey` /
 *     `credential_ref` / `endpoint` substrings — every backend failure
 *     is wrapped in a `ProviderAdapterError` with a generic message.
 *   - Workspace-isolation: a row in workspace A is invisible to a query
 *     scoped to workspace B (no fallback to a global default — that's
 *     a deliberate decision; each workspace must have its own
 *     `platform.workspace_storage_providers` row).
 */
import { and, desc, eq } from 'drizzle-orm';
import type { StorageDb } from '../client';
import { workspaceStorageProviders } from '../schema';
import {
  createS3StorageProviderAdapter,
  ProviderAdapterError,
  type ProviderAdapterConfig,
  type ProviderKind,
  type S3StorageProviderAdapterDeps,
  type StorageProviderAdapter,
} from '../../providers';
import { SecretManagerError, type SecretManagerClient } from '../../providers/secret-manager';
import type {
  ResolvedProvider,
  StorageProviderResolver,
} from '../../../actions/handlers/uploads/types';
import type { ExtendedStorageProviderResolver } from '../../../actions/handlers/objects/types';

/**
 * The DB-level `provider_kind` allowlist is narrower than the runtime
 * adapter `ProviderKind` (the adapter knows about `b2`, `idrive_e2`,
 * `aws_s3` — those land as new DB rows when a follow-up migration adds
 * them to the CHECK constraint). For today's MVP we map the 3 DB values
 * to the corresponding adapter `ProviderKind`:
 *
 *   - `r2`              → `r2`
 *   - `minio`           → `minio`
 *   - `s3_compatible`   → `s3_generic`   (the adapter's generic-S3 quirk path)
 *
 * Adding a new DB `provider_kind` value REQUIRES adding it to:
 *   1. The canonical Supabase migration's CHECK constraint.
 *   2. The Drizzle schema mirror's `STORAGE_PROVIDER_KINDS` array.
 *   3. This map.
 *   4. STORAGE-FU-1's `db:check` drift test (it asserts the mirror
 *      matches the migration).
 */
const DB_PROVIDER_KIND_TO_ADAPTER_KIND: Record<string, ProviderKind> = {
  r2: 'r2',
  minio: 'minio',
  s3_compatible: 's3_generic',
};

/** Region defaults per DB `provider_kind` when the row leaves it NULL. */
const DEFAULT_REGION_FOR_KIND: Record<string, string> = {
  r2: 'auto',
  minio: 'us-east-1',
  s3_compatible: 'us-east-1',
};

/**
 * MinIO + most local-stack providers require path-style addressing.
 * R2 is virtual-hosted-only (path-style returns 308s). AWS S3 supports
 * either; we keep it virtual-hosted by default for portability.
 */
const FORCE_PATH_STYLE_BY_KIND: Record<string, boolean> = {
  minio: true,
  s3_compatible: true,
  r2: false,
};

/**
 * Internal: narrow row shape consumed by the resolver. Mirrors only the
 * columns we actually need — `credential_ref` is intentionally INCLUDED
 * because the resolver consumes it before calling the adapter. It is
 * NEVER returned outside this module.
 */
interface ProviderRowForResolution {
  readonly id: string;
  readonly providerKind: string;
  readonly displayName: string;
  readonly bucket: string;
  readonly region: string | null;
  readonly endpoint: string | null;
  readonly credentialRef: string;
}

export interface PostgresExtendedStorageProviderResolverDeps {
  /** Defaults to `createS3StorageProviderAdapter`. Tests inject a fake. */
  readonly buildAdapter?: (
    config: ProviderAdapterConfig,
    s3Deps?: S3StorageProviderAdapterDeps,
  ) => StorageProviderAdapter;
  /**
   * Optional adapter-level DI seam (e.g. fake `S3Client`). Forwarded
   * verbatim to `buildAdapter`; tests use it to assert the adapter was
   * constructed with the right SDK posture without spinning up real
   * network calls.
   */
  readonly s3AdapterDeps?: S3StorageProviderAdapterDeps;
}

export class PostgresExtendedStorageProviderResolver
  implements StorageProviderResolver, ExtendedStorageProviderResolver
{
  private readonly db: StorageDb;
  private readonly secrets: SecretManagerClient;
  private readonly buildAdapter: NonNullable<
    PostgresExtendedStorageProviderResolverDeps['buildAdapter']
  >;
  private readonly s3AdapterDeps: S3StorageProviderAdapterDeps | undefined;

  constructor(
    db: StorageDb,
    secrets: SecretManagerClient,
    deps: PostgresExtendedStorageProviderResolverDeps = {},
  ) {
    this.db = db;
    this.secrets = secrets;
    this.buildAdapter = deps.buildAdapter ?? createS3StorageProviderAdapter;
    this.s3AdapterDeps = deps.s3AdapterDeps;
  }

  async resolveDefaultForWorkspace(workspaceId: string): Promise<ResolvedProvider | null> {
    if (typeof workspaceId !== 'string' || workspaceId.trim() === '') return null;
    const rows = await this.db
      .select({
        id: workspaceStorageProviders.id,
        providerKind: workspaceStorageProviders.providerKind,
        displayName: workspaceStorageProviders.displayName,
        bucket: workspaceStorageProviders.bucket,
        region: workspaceStorageProviders.region,
        endpoint: workspaceStorageProviders.endpoint,
        credentialRef: workspaceStorageProviders.credentialRef,
      })
      .from(workspaceStorageProviders)
      .where(
        and(
          eq(workspaceStorageProviders.workspaceId, workspaceId),
          eq(workspaceStorageProviders.isDefault, true),
          eq(workspaceStorageProviders.status, 'active'),
        ),
      )
      // Defensive: the partial unique index allows at most ONE default
      // active row per workspace; the `desc(created_at)` + `limit(1)`
      // makes the read deterministic even if a future migration relaxes
      // the constraint.
      .orderBy(desc(workspaceStorageProviders.createdAt))
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    return this.materialiseProvider(row);
  }

  async resolveByProviderIdForWorkspace(input: {
    workspaceId: string;
    providerId: string;
  }): Promise<ResolvedProvider | null> {
    const { workspaceId, providerId } = input;
    if (typeof workspaceId !== 'string' || workspaceId.trim() === '') return null;
    if (typeof providerId !== 'string' || providerId.trim() === '') return null;

    const rows = await this.db
      .select({
        id: workspaceStorageProviders.id,
        providerKind: workspaceStorageProviders.providerKind,
        displayName: workspaceStorageProviders.displayName,
        bucket: workspaceStorageProviders.bucket,
        region: workspaceStorageProviders.region,
        endpoint: workspaceStorageProviders.endpoint,
        credentialRef: workspaceStorageProviders.credentialRef,
      })
      .from(workspaceStorageProviders)
      .where(
        and(
          // Workspace scoping FIRST — a cross-workspace probe returns
          // an empty result set, NOT a row from another workspace.
          eq(workspaceStorageProviders.workspaceId, workspaceId),
          eq(workspaceStorageProviders.id, providerId),
          eq(workspaceStorageProviders.status, 'active'),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    return this.materialiseProvider(row);
  }

  /**
   * Build a `ResolvedProvider` from a row: resolve credentials via the
   * secret manager, build the adapter, return the public shape.
   *
   * All errors are wrapped in `ProviderAdapterError` so backend errors
   * cannot leak credentials / URIs / endpoints into the response
   * envelope.
   */
  private async materialiseProvider(row: ProviderRowForResolution): Promise<ResolvedProvider> {
    const adapterKind = DB_PROVIDER_KIND_TO_ADAPTER_KIND[row.providerKind];
    if (!adapterKind) {
      // Defense-in-depth: the DB CHECK constraint already restricts
      // `provider_kind` to a closed set; if a future migration adds a
      // new value WITHOUT updating the map above, fail fast with a
      // safe message (no DB value echo — we already log `providerId`
      // upstream).
      throw new ProviderAdapterError(
        'PROVIDER_CONFIG_INVALID',
        'Storage provider configuration is unsupported',
      );
    }

    // Resolve credentials via the secret manager. Backend failures are
    // wrapped — the resolver NEVER includes the underlying error text
    // (which could contain the secret-manager path or the credential
    // ref) in the public error.
    let credentials: { accessKeyId: string; secretAccessKey: string };
    try {
      credentials = await this.secrets.resolve(row.credentialRef);
    } catch (err) {
      if (err instanceof SecretManagerError) {
        // Map the closed-set SecretManagerErrorCode to a
        // ProviderAdapterError code + a generic safe message. We
        // deliberately do NOT include the SecretManagerError message —
        // a custom implementation could carry an unsafe payload.
        const code =
          err.code === 'BACKEND_UNAVAILABLE'
            ? 'PROVIDER_OPERATION_FAILED'
            : 'PROVIDER_CONFIG_INVALID';
        throw new ProviderAdapterError(code, 'Storage provider credentials are unavailable');
      }
      // Unknown error from a custom backend — keep the envelope safe.
      throw new ProviderAdapterError(
        'PROVIDER_OPERATION_FAILED',
        'Storage provider credentials are unavailable',
      );
    }

    // Build the adapter config from the allowlisted row fields ONLY.
    const config: ProviderAdapterConfig = {
      providerKind: adapterKind,
      endpoint: chooseEndpoint(row.endpoint),
      region: row.region ?? DEFAULT_REGION_FOR_KIND[row.providerKind] ?? 'us-east-1',
      bucket: row.bucket,
      forcePathStyle: FORCE_PATH_STYLE_BY_KIND[row.providerKind] ?? false,
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    };

    // Construction can throw `ProviderAdapterError('PROVIDER_CONFIG_INVALID', …)`
    // for blank/missing fields; propagate as-is (already redacted).
    const adapter = this.buildAdapter(config, this.s3AdapterDeps);
    return {
      providerId: row.id,
      providerKind: adapterKind,
      adapter,
    };
  }
}

/**
 * Pick the endpoint string. The DB column is nullable because:
 *   - R2 buckets can omit it (we synthesise a placeholder) — but in
 *     practice every R2 row carries the account-scoped endpoint.
 *   - MinIO needs a custom endpoint.
 *   - `s3_compatible` rows MUST carry one.
 *
 * If the row leaves it NULL AND non-empty, we surface
 * `PROVIDER_CONFIG_INVALID` so the operator notices BEFORE the
 * adapter's own validation does. The error message is generic — no
 * value echo.
 */
function chooseEndpoint(rowEndpoint: string | null): string {
  if (rowEndpoint !== null && rowEndpoint.trim().length > 0) {
    return rowEndpoint;
  }
  throw new ProviderAdapterError(
    'PROVIDER_CONFIG_INVALID',
    'Storage provider configuration is incomplete',
  );
}
