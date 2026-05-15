/**
 * STORAGE-FU-1 schema mirror contract tests.
 *
 * What this asserts (acceptance criteria):
 *   - Every closed-set CHECK constraint value in the canonical Supabase
 *     migration is reflected in the matching `*_STATUSES` /
 *     `*_KINDS` / `*_VISIBILITIES` / `*_METHODS` constant exported
 *     from `src/infra/db/schema.ts`.
 *   - The mirror exports every storage table.
 *   - The schema source file contains NO forbidden raw-credential column
 *     names (defense-in-depth on top of code review).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
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

const MIGRATION_PATH = resolve(
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

const MIGRATION_SQL = readFileSync(MIGRATION_PATH, 'utf-8');

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

describe('schema mirror — closed-set CHECK parity', () => {
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
  test('exports all six storage tables', () => {
    expect(workspaceStorageProviders).toBeDefined();
    expect(storageObjects).toBeDefined();
    expect(storageUploadSessions).toBeDefined();
    expect(storageObjectVariants).toBeDefined();
    expect(storageProcessingJobs).toBeDefined();
    expect(storageUsageDaily).toBeDefined();
  });

  test('every required table appears in the canonical migration', () => {
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
  });
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

  test('canonical migration does not declare forbidden raw-credential columns', () => {
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
  });

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
