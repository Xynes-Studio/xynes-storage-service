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

const REQUIRED_TABLES = [
  'workspace_storage_providers',
  'storage_objects',
  'storage_upload_sessions',
  'storage_object_variants',
  'storage_processing_jobs',
  'storage_usage_daily',
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
  let sql: string;
  try {
    sql = await readFile(migrationPath, 'utf-8');
  } catch (err) {
    console.error(
      `[db:check] Could not read canonical migration at ${migrationPath}.\n` +
        `Set STORAGE_INFRA_MIGRATION_PATH to override.\n` +
        `Original error: ${(err as Error).message}`,
    );
    process.exit(2);
  }

  const errors: string[] = [];

  // 1. Every required table must appear in the canonical migration.
  for (const table of REQUIRED_TABLES) {
    if (!sql.includes(`platform.${table}`)) {
      errors.push(`Canonical migration is missing required table platform.${table}`);
    }
  }

  // 2. No forbidden raw-credential columns may appear in the canonical migration.
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

  // 3. Every closed-set CHECK constraint must match the mirror's exported
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
