import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle configuration for `xynes-storage-service`.
 *
 * IMPORTANT — schema ownership:
 *   The canonical source of truth for every `platform.storage_*` table is
 *   `xynes/xynes-infra/supabase/migrations/20260513090000_universal_storage_platform_schema.sql`.
 *   That migration is owned by `xynes-infra`. THIS service does NOT own a
 *   migration directory; `./src/infra/db/schema.ts` is a READ-ONLY Drizzle
 *   mirror of the canonical schema so the service can build type-safe queries
 *   on top of it.
 *
 * If you find yourself reaching for `drizzle-kit generate` or
 * `drizzle-kit push` from THIS repo, stop. Schema changes must land in the
 * `xynes-infra` Supabase migration FIRST; only then update the mirror here.
 *
 * The `out` directory below exists only to give `drizzle-kit check` a place
 * to read existing canonical SQL when validating drift; it is git-ignored
 * for safety.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/infra/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
});
