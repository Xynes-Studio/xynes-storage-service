/**
 * Barrel for the Drizzle DB layer. Re-exports the schema mirror + client
 * factory so STORAGE-FU-2 repositories can `import { storageObjects, type
 * StorageDb } from '../../infra/db'` without reaching into module
 * subpaths.
 */
export * from './schema';
export * from './client';
