/**
 * `bun run db:check` — drift check for the Drizzle schema mirror against
 * the canonical Supabase migration owned by `xynes-infra`.
 *
 * WHY THIS EXISTS (STORAGE-FU-1 acceptance criterion):
 *   `xynes-storage-service` does NOT own the storage schema. The canonical
 *   migration is:
 *     xynes-infra/supabase/migrations/20260513090000_universal_storage_platform_schema.sql
 *   `./src/infra/db/schema.ts` is a read-only mirror of that file. If the
 *   migration ships a new column / `CHECK` value / table and the mirror
 *   is not updated, runtime queries against the new column will silently
 *   fail or return stale typings.
 *
 * WHAT THIS SCRIPT DOES:
 *   1. Locates the canonical migration via `STORAGE_INFRA_MIGRATION_PATH`
 *      (env override for monorepo / CI layout) or the default relative
 *      path: `../xynes-infra/supabase/migrations/...`.
 *   2. Asserts every storage table from the migration is declared in the
 *      mirror.
 *   3. Asserts every closed-set value list (`IN (...)`) in the migration
 *      `CHECK` constraints is reflected in the matching closed-set type
 *      constant exported from `src/infra/db/schema.ts`.
 *   4. Asserts the migration does NOT introduce any forbidden raw-credential
 *      column names (defense-in-depth on top of code review).
 *
 * WHAT THIS SCRIPT DOES NOT DO:
 *   - It does NOT connect to Postgres. It is a static drift check; no
 *     `DATABASE_URL` is required.
 *   - It does NOT run `drizzle-kit push` or `drizzle-kit generate`.
 *     Migrations are owned by `xynes-infra`.
 *
 * Exit codes:
 *   0 — mirror is in sync with the canonical migration.
 *   1 — drift detected; the script prints every diff and exits non-zero
 *       so CI can gate merges on it.
 *   2 — missing inputs (migration file or schema file not found).
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  STORAGE_PROVIDER_KINDS,
  STORAGE_PROVIDER_STATUSES,
  STORAGE_OBJECT_STATUSES,
  STORAGE_OBJECT_VISIBILITIES,
  UPLOAD_SESSION_METHODS,
  UPLOAD_SESSION_STATUSES,
  STORAGE_VARIANT_STATUSES,
  PROCESSING_JOB_STATUSES,
  STORAGE_OBJECT_REFERENCE_OWNER_KINDS,
} from '../src/infra/db/schema';

const DEFAULT_MIGRATION_PATH = resolve(
  import.meta.dir,
  '..',
  '..',
  'xynes-infra',
  'supabase',
  'migrations',
  '20260513090000_universal_storage_platform_schema.sql',
);

/**
 * DEDUP-1 + STORAGE-FU-2-FU-1 add additional canonical migrations
 * alongside the STORAGE-2 base schema. The drift check reads them all
 * and concatenates the SQL so table / CHECK / forbidden-column /
 * required-index assertions work uniformly.
 *
 * Override the additional paths via `STORAGE_INFRA_EXTRA_MIGRATION_PATHS`
 * (colon-separated). Defaults are the canonical paths of every storage
 * follow-up migration the mirror depends on.
 */
const DEFAULT_EXTRA_MIGRATION_PATHS = [
  resolve(
    import.meta.dir,
    '..',
    '..',
    'xynes-infra',
    'supabase',
    'migrations',
    '20260528090000_storage_object_references_and_dedup_index.sql',
  ),
  resolve(
    import.meta.dir,
    '..',
    '..',
    'xynes-infra',
    'supabase',
    'migrations',
    '20260528100000_storage_processing_jobs_active_unique_index.sql',
  ),
] as const;

const REQUIRED_TABLES = [
  'workspace_storage_providers',
  'storage_objects',
  'storage_upload_sessions',
  'storage_object_variants',
  'storage_processing_jobs',
  'storage_usage_daily',
  'storage_object_references',
] as const;

const FORBIDDEN_COLUMN_NAMES = [
  'provider_credentials',
  'raw_key',
  'secret_access_key',
  'r2_token',
  'signed_url',
  'presigned_url',
  'access_key_id',
] as const;

interface CheckedConstraint {
  readonly description: string;
  readonly migrationPattern: RegExp;
  readonly mirrorValues: readonly string[];
}

const CHECKED_CONSTRAINTS: readonly CheckedConstraint[] = [
  {
    description: 'workspace_storage_providers.provider_kind',
    migrationPattern: /provider_kind\s+IN\s+\(([^)]+)\)/,
    mirrorValues: STORAGE_PROVIDER_KINDS,
  },
  {
    description: 'workspace_storage_providers.status',
    migrationPattern: /workspace_storage_providers_status_check[\s\S]*?status\s+IN\s+\(([^)]+)\)/,
    mirrorValues: STORAGE_PROVIDER_STATUSES,
  },
  {
    description: 'storage_objects.status',
    migrationPattern: /storage_objects_status_check[\s\S]*?status\s+IN\s+\(([^)]+)\)/,
    mirrorValues: STORAGE_OBJECT_STATUSES,
  },
  {
    description: 'storage_objects.visibility',
    migrationPattern: /storage_objects_visibility_check[\s\S]*?visibility\s+IN\s+\(([^)]+)\)/,
    mirrorValues: STORAGE_OBJECT_VISIBILITIES,
  },
  {
    description: 'storage_upload_sessions.upload_method',
    migrationPattern:
      /storage_upload_sessions_method_check[\s\S]*?upload_method\s+IN\s+\(([^)]+)\)/,
    mirrorValues: UPLOAD_SESSION_METHODS,
  },
  {
    description: 'storage_upload_sessions.status',
    migrationPattern: /storage_upload_sessions_status_check[\s\S]*?status\s+IN\s+\(([^)]+)\)/,
    mirrorValues: UPLOAD_SESSION_STATUSES,
  },
  {
    description: 'storage_object_variants.status',
    migrationPattern: /storage_object_variants_status_check[\s\S]*?status\s+IN\s+\(([^)]+)\)/,
    mirrorValues: STORAGE_VARIANT_STATUSES,
  },
  {
    description: 'storage_processing_jobs.status',
    migrationPattern: /storage_processing_jobs_status_check[\s\S]*?status\s+IN\s+\(([^)]+)\)/,
    mirrorValues: PROCESSING_JOB_STATUSES,
  },
  {
    description: 'storage_object_references.owner_kind',
    migrationPattern:
      /storage_object_references_owner_kind_check[\s\S]*?owner_kind\s+IN\s+\(([^)]+)\)/,
    mirrorValues: STORAGE_OBJECT_REFERENCE_OWNER_KINDS,
  },
];

function parseInValues(match: string): string[] {
  // Migration uses `IN ('a', 'b', 'c')`. We split on commas, trim, and
  // strip surrounding single quotes. Conservative on whitespace; fails
  // loud if the migration uses unexpected formatting.
  return match
    .split(',')
    .map((s) => s.trim().replace(/^'|'$/g, ''))
    .filter((s) => s.length > 0);
}

async function main(): Promise<void> {
  const migrationPath = process.env.STORAGE_INFRA_MIGRATION_PATH ?? DEFAULT_MIGRATION_PATH;

  // Load the base migration AND every additional canonical migration that
  // contributes columns / tables / CHECK constraints the mirror depends on.
  // Concatenation works because every assertion below is a substring /
  // regex match against the combined SQL — order doesn't matter.
  const extraPathsRaw = process.env.STORAGE_INFRA_EXTRA_MIGRATION_PATHS;
  const extraPaths: string[] = extraPathsRaw
    ? extraPathsRaw
        .split(':')
        .map((p) => p.trim())
        .filter((p) => p.length > 0)
    : [...DEFAULT_EXTRA_MIGRATION_PATHS];

  const allPaths = [migrationPath, ...extraPaths];
  const sqlParts: string[] = [];

  for (const p of allPaths) {
    try {
      sqlParts.push(await readFile(p, 'utf-8'));
    } catch (err) {
      console.error(
        `[db:check] Could not read canonical migration at ${p}.\n` +
          `Set STORAGE_INFRA_MIGRATION_PATH (base) or STORAGE_INFRA_EXTRA_MIGRATION_PATHS (additional) to override.\n` +
          `Original error: ${(err as Error).message}`,
      );
      process.exit(2);
    }
  }

  const sql = sqlParts.join('\n-- END OF MIGRATION FILE --\n');

  const errors: string[] = [];

  // 1. Every required table must appear in the concatenated canonical migrations.
  for (const table of REQUIRED_TABLES) {
    if (!sql.includes(`platform.${table}`)) {
      errors.push(`Canonical migrations are missing required table platform.${table}`);
    }
  }

  // 2. No forbidden raw-credential columns may appear in any canonical migration.
  for (const forbidden of FORBIDDEN_COLUMN_NAMES) {
    // Match column declarations `forbidden_name TYPE` only (avoid matching
    // the security comment paragraph at the top of the migration that lists
    // the same names as banned).
    const declarationPattern = new RegExp(`^\\s*${forbidden}\\s+`, 'mi');
    if (declarationPattern.test(sql)) {
      errors.push(
        `Canonical migration contains forbidden raw-credential column \`${forbidden}\`. ` +
          `Credential storage MUST be a reference (credential_ref), not a raw value.`,
      );
    }
  }

  // 3. DEDUP-1 invariant: the workspace-scoped partial unique index on
  //    (workspace_id, sha256) MUST be present so dedup is structurally
  //    workspace-scoped. A unique index keyed on `sha256` alone would be
  //    a cross-tenant leak.
  if (!sql.includes('storage_objects_workspace_sha256_uidx')) {
    errors.push(
      'DEDUP-1 invariant violated: missing partial unique index ' +
        '`storage_objects_workspace_sha256_uidx` on platform.storage_objects ' +
        '(workspace_id, sha256). Dedup MUST be workspace-scoped.',
    );
  }

  // 3b. STORAGE-FU-2-FU-1 invariant: the partial unique index on
  //     (object_id, job_kind) for ACTIVE (queued/running) processing
  //     jobs MUST be present so duplicate active jobs are rejected at
  //     the DB layer, not just by the transaction-level pre-check in
  //     `PostgresProcessingJobQueueRepository.enqueueBatch`. The partial
  //     predicate is critical: a global unique index would forever
  //     block STORAGE-7 retries after terminal `failed` / `succeeded` /
  //     `cancelled` outcomes.
  if (!sql.includes('storage_processing_jobs_active_unique_uidx')) {
    errors.push(
      'STORAGE-FU-2-FU-1 invariant violated: missing partial unique index ' +
        '`storage_processing_jobs_active_unique_uidx` on platform.storage_processing_jobs ' +
        '(object_id, job_kind) WHERE status IN (queued, running). ' +
        'Duplicate active processing jobs MUST be rejected at the DB layer.',
    );
  }

  // 4. Every closed-set CHECK constraint must match the mirror's exported
  //    type-union constants exactly (set-equality, ignoring source order).
  for (const constraint of CHECKED_CONSTRAINTS) {
    const match = sql.match(constraint.migrationPattern);
    if (!match) {
      errors.push(
        `Could not find CHECK pattern for ${constraint.description} in canonical migration. ` +
          `Update db-check.ts if the migration was reformatted.`,
      );
      continue;
    }
    const migrationValues = new Set(parseInValues(match[1]));
    const mirrorValues = new Set(constraint.mirrorValues);

    const missingFromMirror = [...migrationValues].filter((v) => !mirrorValues.has(v));
    const missingFromMigration = [...mirrorValues].filter((v) => !migrationValues.has(v));

    if (missingFromMirror.length > 0) {
      errors.push(
        `${constraint.description}: migration has values not declared in mirror: ${missingFromMirror.join(
          ', ',
        )}`,
      );
    }
    if (missingFromMigration.length > 0) {
      errors.push(
        `${constraint.description}: mirror has values not declared in migration: ${missingFromMigration.join(
          ', ',
        )}`,
      );
    }
  }

  if (errors.length > 0) {
    console.error('[db:check] Drift detected between Drizzle mirror and canonical migration:');
    for (const e of errors) {
      console.error(`  - ${e}`);
    }
    console.error(
      `\nCanonical migration: ${migrationPath}\n` +
        `Mirror: src/infra/db/schema.ts\n\n` +
        `Fix the mirror to match the canonical migration (the migration is the source of truth).`,
    );
    process.exit(1);
  }

  console.log('[db:check] Drizzle mirror is in sync with the canonical Supabase migration.');
}

await main();
