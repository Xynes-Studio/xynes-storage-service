/**
 * STORAGE-FU-3 — Secret-manager interface for resolving the raw provider
 * credentials referenced by `platform.workspace_storage_providers.credential_ref`.
 *
 * Plan §6 acceptance criteria:
 *   - `credential_ref` is a vendor-neutral URI string.
 *   - The resolver hands it to a `SecretManagerClient` implementation; the
 *     implementation maps the URI to a secret-manager backend (env vars
 *     for local dev; AWS Secrets Manager / GCP Secret Manager / Doppler /
 *     Vault for hosted environments — each is a separate follow-up story).
 *   - The interface ships now; hosted implementations land per-environment.
 *
 * Security invariants enforced here:
 *   - Raw credentials NEVER touch Postgres.
 *   - Raw credentials NEVER appear in error messages or logs.
 *   - The closed-set `SecretManagerErrorCode` lets the resolver wrap
 *     backend failures into a redacted envelope without leaking the
 *     underlying error text, the URI, or the secret-manager path.
 *   - URI parsing rejects anything that is not `secret://<path>` so a
 *     hostile `credential_ref` cannot smuggle a `file://` / `http://` /
 *     `?query=` payload through to the backend.
 */

/**
 * The shape every secret-manager backend resolves to. Field names match
 * `ProviderAdapterConfig.{accessKeyId,secretAccessKey}` so the resolver
 * can pass the result straight to the adapter without remapping.
 */
export interface ProviderCredentialMaterial {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/**
 * Closed-set error codes returned by a `SecretManagerClient`. The
 * resolver wraps these into a `PROVIDER_CONFIG_INVALID` /
 * `PROVIDER_OPERATION_FAILED` envelope so callers never see the raw
 * backend error.
 *
 * - `NOT_FOUND`         — backend has no entry for the path.
 * - `BACKEND_UNAVAILABLE` — transient backend failure (retryable).
 * - `MATERIAL_INVALID`  — entry exists but is missing required fields
 *                        or contains blank values. Defense-in-depth so
 *                        a malformed env block is detected at resolve
 *                        time rather than at adapter PUT time.
 * - `URI_INVALID`       — `credential_ref` is not a parseable
 *                        `secret://<path>` URI.
 */
export type SecretManagerErrorCode =
  | 'NOT_FOUND'
  | 'BACKEND_UNAVAILABLE'
  | 'MATERIAL_INVALID'
  | 'URI_INVALID';

export class SecretManagerError extends Error {
  public readonly code: SecretManagerErrorCode;
  constructor(code: SecretManagerErrorCode, message: string) {
    super(message);
    this.name = 'SecretManagerError';
    this.code = code;
  }
}

/**
 * Vendor-neutral secret-manager contract. The resolver depends on this
 * interface, not on any specific backend.
 *
 * Implementations MUST:
 *   - Accept a `credential_ref` URI of the form `secret://<path>` where
 *     `<path>` is a non-empty, slash-delimited identifier (e.g.
 *     `secret://storage/r2/dev`, `secret://aws/secrets-manager/storage`).
 *   - Reject any other scheme with `URI_INVALID`.
 *   - Return `ProviderCredentialMaterial` whose two fields are both
 *     non-empty strings.
 *   - NEVER include the raw secret in error messages — error text MUST
 *     be safe to log.
 */
export interface SecretManagerClient {
  /**
   * Resolve `credential_ref` to raw provider credentials.
   *
   * Throws `SecretManagerError` on failure. The resolver translates
   * those throws into a redacted `PROVIDER_CONFIG_INVALID` /
   * `PROVIDER_OPERATION_FAILED` envelope.
   */
  resolve(credentialRef: string): Promise<ProviderCredentialMaterial>;
}

// ── secret:// URI parser ───────────────────────────────────────────────────

/**
 * Parses a `credential_ref` string into a `secret://` path. Returns the
 * path component WITHOUT the `secret://` prefix. Throws
 * `SecretManagerError('URI_INVALID', ...)` on any malformed input.
 *
 * Strict rules (defense-in-depth — DB constraints already require the
 * value to be non-blank; this guard prevents downgrades to other
 * schemes if a future migration relaxes the constraint):
 *   - Must start with the literal `secret://`.
 *   - Path after the prefix MUST be non-empty.
 *   - No URL query string, no fragment, no `..`, no leading slash.
 *   - Allowed chars: lowercase letters, digits, `-`, `_`, `/`.
 *   - Path length 1..256 chars.
 */
export function parseSecretRef(credentialRef: string): string {
  if (typeof credentialRef !== 'string') {
    throw new SecretManagerError('URI_INVALID', 'credential_ref must be a string');
  }
  const trimmed = credentialRef.trim();
  if (trimmed.length === 0) {
    throw new SecretManagerError('URI_INVALID', 'credential_ref must not be empty');
  }
  const prefix = 'secret://';
  if (!trimmed.startsWith(prefix)) {
    throw new SecretManagerError('URI_INVALID', 'credential_ref must use the secret:// scheme');
  }
  const path = trimmed.slice(prefix.length);
  if (path.length === 0) {
    throw new SecretManagerError('URI_INVALID', 'credential_ref path must not be empty');
  }
  if (path.length > 256) {
    throw new SecretManagerError(
      'URI_INVALID',
      'credential_ref path exceeds the 256-character limit',
    );
  }
  if (path.startsWith('/')) {
    throw new SecretManagerError('URI_INVALID', 'credential_ref path must not start with "/"');
  }
  if (path.includes('..')) {
    throw new SecretManagerError('URI_INVALID', 'credential_ref path must not contain ".."');
  }
  if (path.includes('?') || path.includes('#')) {
    throw new SecretManagerError(
      'URI_INVALID',
      'credential_ref must not contain query or fragment components',
    );
  }
  if (!/^[a-z0-9_/-]+$/.test(path)) {
    throw new SecretManagerError(
      'URI_INVALID',
      'credential_ref path contains forbidden characters',
    );
  }
  return path;
}

/**
 * Maps a `secret://` path to an env-var prefix:
 *   `secret://storage/r2/dev`  →  `STORAGE_CREDENTIAL_STORAGE_R2_DEV`
 *
 * Slashes and dashes become underscores; case is uppercased.
 *
 * Pure function so tests can assert the mapping without touching env.
 */
export function secretPathToEnvPrefix(path: string): string {
  const sanitised = path.replace(/[/-]/g, '_').toUpperCase();
  return `STORAGE_CREDENTIAL_${sanitised}`;
}

// ── EnvSecretManagerClient (local-dev) ─────────────────────────────────────

/**
 * Local-dev `SecretManagerClient` that reads credentials from the
 * process environment. This keeps `bun run dev` runnable on a clean
 * laptop without a hosted secret manager.
 *
 * For each `secret://<path>` the client reads:
 *   - `STORAGE_CREDENTIAL_<UPPERCASE_PATH>_ACCESS_KEY_ID`
 *   - `STORAGE_CREDENTIAL_<UPPERCASE_PATH>_SECRET_ACCESS_KEY`
 *
 * Missing env vars surface as `NOT_FOUND`; blank values surface as
 * `MATERIAL_INVALID`.
 *
 * Hosted environments wire a different `SecretManagerClient` (AWS
 * Secrets Manager, Doppler, Vault) in their composition root — the
 * resolver does not care which backend serves the call.
 */
export interface EnvSecretManagerClientDeps {
  /** Defaults to `process.env`. Tests inject a frozen object. */
  readonly env?: NodeJS.ProcessEnv;
}

export class EnvSecretManagerClient implements SecretManagerClient {
  private readonly env: NodeJS.ProcessEnv;
  constructor(deps: EnvSecretManagerClientDeps = {}) {
    this.env = deps.env ?? process.env;
  }

  async resolve(credentialRef: string): Promise<ProviderCredentialMaterial> {
    const path = parseSecretRef(credentialRef);
    const prefix = secretPathToEnvPrefix(path);
    const accessKeyId = this.env[`${prefix}_ACCESS_KEY_ID`];
    const secretAccessKey = this.env[`${prefix}_SECRET_ACCESS_KEY`];

    // `NOT_FOUND` vs `MATERIAL_INVALID`:
    //   - Both env vars missing entirely  → NOT_FOUND
    //   - One present, the other missing  → MATERIAL_INVALID (partial config)
    //   - Both present but blank          → MATERIAL_INVALID
    if (accessKeyId === undefined && secretAccessKey === undefined) {
      throw new SecretManagerError(
        'NOT_FOUND',
        'No env-backed credential found for the requested credential_ref',
      );
    }
    if (accessKeyId === undefined || secretAccessKey === undefined) {
      throw new SecretManagerError(
        'MATERIAL_INVALID',
        'Env-backed credential is partially configured',
      );
    }
    if (accessKeyId.trim().length === 0 || secretAccessKey.trim().length === 0) {
      throw new SecretManagerError(
        'MATERIAL_INVALID',
        'Env-backed credential contains blank fields',
      );
    }

    return { accessKeyId, secretAccessKey };
  }
}
