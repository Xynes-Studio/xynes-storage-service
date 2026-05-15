/**
 * Barrel re-export sanity check.
 */
import { describe, expect, test } from 'bun:test';
import * as barrel from '../../../src/infra/db';

describe('infra/db barrel', () => {
  test('re-exports the schema tables', () => {
    expect(barrel.workspaceStorageProviders).toBeDefined();
    expect(barrel.storageObjects).toBeDefined();
    expect(barrel.storageUploadSessions).toBeDefined();
    expect(barrel.storageObjectVariants).toBeDefined();
    expect(barrel.storageProcessingJobs).toBeDefined();
    expect(barrel.storageUsageDaily).toBeDefined();
  });

  test('re-exports the closed-set type constants', () => {
    expect(barrel.STORAGE_PROVIDER_KINDS).toBeDefined();
    expect(barrel.STORAGE_OBJECT_STATUSES).toBeDefined();
    expect(barrel.UPLOAD_SESSION_STATUSES).toBeDefined();
    expect(barrel.PROCESSING_JOB_STATUSES).toBeDefined();
  });

  test('re-exports the client factory', () => {
    expect(typeof barrel.createStorageDb).toBe('function');
  });
});
