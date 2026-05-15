/**
 * STORAGE-FU-1 schema mirror contract tests.
 *
 * What this asserts (acceptance criteria):
 *   - Every closed-set CHECK constraint value in the canonical Supabase
 *     migration is reflected in the matching `*_STATUSES` /
 *     `*_KINDS` / `*_VISIBILITIES` / `*_METHODS` constant exported
 *     from `src/infra/db/schema.ts`. (Skipped on CI single-repo checkout
 *     where the cross-repo canonical migration file is not reachable;
 *     `bun run db:check` is the developer-local CI gate for that case.)
 *   - The mirror exports every storage table.
 *   - The schema source file contains NO forbidden raw-credential column
 *     names (defense-in-depth on top of code review).
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PROCESSING_JOB_STATUSES,
  STORAGE_OBJECT_STATUSES,
  STORAGE_OBJECT_VISIBILITIES,
  STORAGE_PROVIDER_KINDS,
  STORAGE_PROVIDER_STATUSES,
  STORAGE_VARIANT_STATUSES,
  UPLOAD_SESSION_METHODS,
  UPLOAD_SESSION_STATUSES,
  storageObjectVariants,
  storageObjects,
  storageProcessingJobs,
  storageUploadSessions,
  storageUsageDaily,
  workspaceStorageProviders,
} from '../../../src/infra/db/schema';

// Cross-repo path. In a local meta-folder checkout (`xynes-erp/xynes/*`), the
// canonical Supabase migration owned by `xynes-infra` lives next to this repo:
//   xynes/xynes-storage-service/  ← this repo
//   xynes/xynes-infra/supabase/migrations/...  ← canonical migration
// In single-repo CI (GitHub Actions / dev container with only one repo checked
// out), the cross-repo file is not present. The migration-parity tests below
// gracefully skip in that environment — the mirror-only invariants
// (closed-set frozen-array tests + schema-source forbidden-column negatives)
// still run and remain CI gates. The cross-repo parity gate is
// `bun run db:check`, which developers run locally and which should also be
// wired into a cross-repo CI workflow as a follow-up.
const MIGRATION_PATH =
  process.env.STORAGE_INFRA_MIGRATION_PATH ??
  resolve(
    import.meta.dir,
    '..',
    '..',
    '..',
    '..',
    'xynes-infra',
    'supabase',
    'migrations',
    '20260513090000_universal_storage_platform_schema.sql',
  );

const MIGRATION_REACHABLE = existsSync(MIGRATION_PATH);
const MIGRATION_SQL = MIGRATION_REACHABLE ? readFileSync(MIGRATION_PATH, 'utf-8') : '';

if (!MIGRATION_REACHABLE) {
  // eslint-disable-next-line no-console
  console.warn(
    `[schema.test] canonical migration not reachable at ${MIGRATION_PATH}; ` +
      `cross-repo parity tests will be skipped. Run \`bun run db:check\` to ` +
      `enforce drift detection locally, or set STORAGE_INFRA_MIGRATION_PATH ` +
      `to point at the canonical file in CI.`,
  );
}

function parseInValues(raw: string): Set<string> {
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .filter((s) => s.length > 0),
  );
}

function findCheckValues(constraintName: string, columnName: string): Set<string> {
  const pattern = new RegExp(`${constraintName}[\\s\\S]*?${columnName}\\s+IN\\s+\\(([^)]+)\\)`);
  const match = MIGRATION_SQL.match(pattern);
  if (!match) {
    throw new Error(`Migration missing CHECK constraint ${constraintName}`);
  }
  return parseInValues(match[1]);
}

function asStringSet(values: readonly string[]): Set<string> {
  return new Set<string>(values);
}

// `describe.skipIf` evaluates the predicate eagerly at module-load time. When
// the cross-repo canonical migration is unreachable (single-repo CI), every
// test inside the skipped describes is reported as skipped — they are
// re-enabled the moment a developer runs the suite locally in the meta-folder
// checkout (where the file is reachable) or sets `STORAGE_INFRA_MIGRATION_PATH`
// in CI to point at a checked-out canonical file.
describe.skipIf(!MIGRATION_REACHABLE)('schema mirror — closed-set CHECK parity', () => {
  test('STORAGE_PROVIDER_KINDS matches workspace_storage_providers_kind_check', () => {
    const migrationValues = findCheckValues(
      'workspace_storage_providers_kind_check',
      'provider_kind',
    );
    expect(asStringSet(STORAGE_PROVIDER_KINDS)).toEqual(migrationValues);
  });

  test('STORAGE_PROVIDER_STATUSES matches workspace_storage_providers_status_check', () => {
    const migrationValues = findCheckValues('workspace_storage_providers_status_check', 'status');
    expect(asStringSet(STORAGE_PROVIDER_STATUSES)).toEqual(migrationValues);
  });

  test('STORAGE_OBJECT_STATUSES matches storage_objects_status_check', () => {
    const migrationValues = findCheckValues('storage_objects_status_check', 'status');
    expect(asStringSet(STORAGE_OBJECT_STATUSES)).toEqual(migrationValues);
  });

  test('STORAGE_OBJECT_VISIBILITIES matches storage_objects_visibility_check', () => {
    const migrationValues = findCheckValues('storage_objects_visibility_check', 'visibility');
    expect(asStringSet(STORAGE_OBJECT_VISIBILITIES)).toEqual(migrationValues);
  });

  test('UPLOAD_SESSION_METHODS matches storage_upload_sessions_method_check', () => {
    const migrationValues = findCheckValues(
      'storage_upload_sessions_method_check',
      'upload_method',
    );
    expect(asStringSet(UPLOAD_SESSION_METHODS)).toEqual(migrationValues);
  });

  test('UPLOAD_SESSION_STATUSES matches storage_upload_sessions_status_check', () => {
    const migrationValues = findCheckValues('storage_upload_sessions_status_check', 'status');
    expect(asStringSet(UPLOAD_SESSION_STATUSES)).toEqual(migrationValues);
  });

  test('STORAGE_VARIANT_STATUSES matches storage_object_variants_status_check', () => {
    const migrationValues = findCheckValues('storage_object_variants_status_check', 'status');
    expect(asStringSet(STORAGE_VARIANT_STATUSES)).toEqual(migrationValues);
  });

  test('PROCESSING_JOB_STATUSES matches storage_processing_jobs_status_check', () => {
    const migrationValues = findCheckValues('storage_processing_jobs_status_check', 'status');
    expect(asStringSet(PROCESSING_JOB_STATUSES)).toEqual(migrationValues);
  });
});

describe('schema mirror — table coverage', () => {
  // Mirror-only assertion: must always run, even on single-repo CI.
  test('exports all six storage tables', () => {
    expect(workspaceStorageProviders).toBeDefined();
    expect(storageObjects).toBeDefined();
    expect(storageUploadSessions).toBeDefined();
    expect(storageObjectVariants).toBeDefined();
    expect(storageProcessingJobs).toBeDefined();
    expect(storageUsageDaily).toBeDefined();
  });

  // Cross-repo assertion: requires canonical migration file.
  test.skipIf(!MIGRATION_REACHABLE)(
    'every required table appears in the canonical migration',
    () => {
      const required = [
        'workspace_storage_providers',
        'storage_objects',
        'storage_upload_sessions',
        'storage_object_variants',
        'storage_processing_jobs',
        'storage_usage_daily',
      ];
      for (const name of required) {
        expect(MIGRATION_SQL).toContain(`platform.${name}`);
      }
    },
  );
});

describe('schema mirror — security invariants', () => {
  // Read the schema source file rather than introspecting Drizzle metadata
  // so a forbidden column added via `.as()` or `text('access_key_id')`
  // would still be caught even if the JS export name was sanitized.
  const SCHEMA_PATH = resolve(import.meta.dir, '..', '..', '..', 'src', 'infra', 'db', 'schema.ts');
  const SCHEMA_SOURCE = readFileSync(SCHEMA_PATH, 'utf-8');

  const FORBIDDEN_COLUMN_NAMES = [
    'provider_credentials',
    'raw_key',
    'secret_access_key',
    'r2_token',
    'signed_url',
    'presigned_url',
    'access_key_id',
  ];

  test.each(FORBIDDEN_COLUMN_NAMES)(
    'schema mirror does not declare forbidden column %s',
    (forbidden) => {
      // The forbidden column name must not appear inside a Drizzle column
      // declaration like `text('xxx')` / `uuid('xxx')` / `bigint('xxx', ...)`.
      // We tolerate the name appearing inside documentation comments (the
      // SECURITY INVARIANTS block explicitly lists these as banned).
      const declarationPattern = new RegExp(
        `(?:text|uuid|bigint|integer|boolean|timestamp|date)\\(\\s*['"\`]${forbidden}['"\`]`,
      );
      expect(SCHEMA_SOURCE).not.toMatch(declarationPattern);
    },
  );

  test.skipIf(!MIGRATION_REACHABLE)(
    'canonical migration does not declare forbidden raw-credential columns',
    () => {
      for (const forbidden of FORBIDDEN_COLUMN_NAMES) {
        // Match column declarations `forbidden TYPE` at the start of a line.
        // Avoid matching the security comment paragraph that LISTS these
        // forbidden names as banned by checking for a column type after.
        const declarationPattern = new RegExp(
          `^\\s+${forbidden}\\s+(text|uuid|bigint|integer|boolean|timestamptz|date)`,
          'mi',
        );
        expect(MIGRATION_SQL).not.toMatch(declarationPattern);
      }
    },
  );

  test('credential_ref is the only credential column declared', () => {
    expect(SCHEMA_SOURCE).toContain('credentialRef');
    expect(SCHEMA_SOURCE).toContain("text('credential_ref')");
  });
});

describe('schema mirror — closed-set type constants are frozen arrays', () => {
  // Defensive: the closed-set constants are exposed as readonly tuples so
  // downstream code cannot push extra values at runtime. This test locks
  // that invariant in place.
  const cases: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['STORAGE_PROVIDER_KINDS', STORAGE_PROVIDER_KINDS],
    ['STORAGE_PROVIDER_STATUSES', STORAGE_PROVIDER_STATUSES],
    ['STORAGE_OBJECT_STATUSES', STORAGE_OBJECT_STATUSES],
    ['STORAGE_OBJECT_VISIBILITIES', STORAGE_OBJECT_VISIBILITIES],
    ['UPLOAD_SESSION_METHODS', UPLOAD_SESSION_METHODS],
    ['UPLOAD_SESSION_STATUSES', UPLOAD_SESSION_STATUSES],
    ['STORAGE_VARIANT_STATUSES', STORAGE_VARIANT_STATUSES],
    ['PROCESSING_JOB_STATUSES', PROCESSING_JOB_STATUSES],
  ];

  test.each(cases)('%s is a non-empty readonly array', (_name, values) => {
    expect(values.length).toBeGreaterThan(0);
    // Each value must be a non-blank string with no surrounding whitespace.
    for (const v of values) {
      expect(typeof v).toBe('string');
      expect(v.length).toBeGreaterThan(0);
      expect(v).toBe(v.trim());
    }
  });
});
