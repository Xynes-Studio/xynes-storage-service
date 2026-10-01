-- Isolated test fixture only; never apply to an application database.
-- Storage DDL copied from xynes-infra canonical 20260513090000 migration.
-- Anchor tables below only support synthetic FK fixtures.
CREATE SCHEMA identity;
CREATE SCHEMA platform;
CREATE TABLE identity.users (id uuid PRIMARY KEY, email text, created_at timestamptz DEFAULT now());
CREATE TABLE platform.workspaces (id uuid PRIMARY KEY, name text, slug text, created_by uuid REFERENCES identity.users(id), plan_type text, created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS platform.workspace_storage_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES platform.workspaces(id) ON DELETE CASCADE,
  provider_kind text NOT NULL,
  display_name text NOT NULL,
  bucket text NOT NULL,
  region text,
  endpoint text,
  credential_ref text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  is_default boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES identity.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT workspace_storage_providers_kind_check
    CHECK (provider_kind IN ('r2', 'minio', 's3_compatible')),
  CONSTRAINT workspace_storage_providers_status_check
    CHECK (status IN ('active', 'disabled')),
  CONSTRAINT workspace_storage_providers_credential_ref_not_blank CHECK (btrim(credential_ref) <> ''),
  CONSTRAINT workspace_storage_providers_bucket_not_blank CHECK (btrim(bucket) <> ''),
  CONSTRAINT workspace_storage_providers_display_name_not_blank CHECK (btrim(display_name) <> '')
);

CREATE TABLE IF NOT EXISTS platform.storage_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES platform.workspaces(id) ON DELETE CASCADE,
  provider_id uuid NOT NULL REFERENCES platform.workspace_storage_providers(id),
  provider_object_key text NOT NULL,
  filename text NOT NULL,
  content_type text NOT NULL,
  byte_size bigint NOT NULL,
  sha256 text,
  purpose text NOT NULL DEFAULT 'platform_generic',
  visibility text NOT NULL DEFAULT 'private',
  status text NOT NULL DEFAULT 'pending_upload',
  compression_requested boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES identity.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  uploaded_at timestamptz,
  ready_at timestamptz,
  deleted_at timestamptz,
  failure_code text,
  failure_message text,

  CONSTRAINT storage_objects_status_check CHECK (status IN ('pending_upload', 'uploaded', 'processing', 'ready', 'failed', 'deleted')),
  CONSTRAINT storage_objects_visibility_check CHECK (visibility IN ('private', 'public')),
  CONSTRAINT storage_objects_filename_not_blank CHECK (btrim(filename) <> ''),
  CONSTRAINT storage_objects_content_type_not_blank CHECK (btrim(content_type) <> ''),
  CONSTRAINT storage_objects_purpose_not_blank CHECK (btrim(purpose) <> ''),
  CONSTRAINT storage_objects_byte_size_non_negative CHECK (byte_size >= 0),
  CONSTRAINT storage_objects_provider_object_key_not_blank CHECK (btrim(provider_object_key) <> ''),
  -- Soft-delete consistency: once status='deleted', deleted_at must be set.
  CONSTRAINT storage_objects_deleted_consistency CHECK (
    (status = 'deleted' AND deleted_at IS NOT NULL) OR status <> 'deleted'
  )
);

CREATE TABLE IF NOT EXISTS platform.storage_upload_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES platform.workspaces(id) ON DELETE CASCADE,
  object_id uuid NOT NULL REFERENCES platform.storage_objects(id) ON DELETE CASCADE,
  upload_method text NOT NULL,
  provider_upload_id text,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  aborted_at timestamptz,
  created_by uuid REFERENCES identity.users(id) ON DELETE SET NULL,

  CONSTRAINT storage_upload_sessions_method_check
    CHECK (upload_method IN ('single', 'multipart')),
  CONSTRAINT storage_upload_sessions_status_check
    CHECK (status IN ('pending', 'completed', 'aborted', 'expired')),
  CONSTRAINT storage_upload_sessions_completed_consistency CHECK (
    (status = 'completed' AND completed_at IS NOT NULL) OR status <> 'completed'
  ),
  CONSTRAINT storage_upload_sessions_aborted_consistency CHECK (
    (status = 'aborted' AND aborted_at IS NOT NULL) OR status <> 'aborted'
  )
);

CREATE TABLE IF NOT EXISTS platform.storage_object_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id uuid NOT NULL REFERENCES platform.storage_objects(id) ON DELETE CASCADE,
  variant_kind text NOT NULL,
  provider_object_key text NOT NULL,
  content_type text NOT NULL,
  byte_size bigint NOT NULL,
  width integer,
  height integer,
  duration_ms integer,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,

  CONSTRAINT storage_object_variants_status_check CHECK (status IN ('pending', 'ready', 'failed')),
  CONSTRAINT storage_object_variants_kind_not_blank CHECK (btrim(variant_kind) <> ''),
  CONSTRAINT storage_object_variants_byte_size_non_negative CHECK (byte_size >= 0),
  CONSTRAINT storage_object_variants_provider_key_not_blank CHECK (btrim(provider_object_key) <> '')
);

CREATE TABLE IF NOT EXISTS platform.storage_processing_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id uuid NOT NULL REFERENCES platform.storage_objects(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES platform.workspaces(id) ON DELETE CASCADE,
  job_kind text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0,
  scheduled_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT storage_processing_jobs_status_check
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT storage_processing_jobs_kind_not_blank CHECK (btrim(job_kind) <> ''),
  CONSTRAINT storage_processing_jobs_attempts_non_negative CHECK (attempts >= 0)
);

CREATE TABLE IF NOT EXISTS platform.storage_usage_daily (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES platform.workspaces(id) ON DELETE CASCADE,
  provider_id uuid REFERENCES platform.workspace_storage_providers(id),
  usage_date date NOT NULL,
  bytes_stored bigint NOT NULL DEFAULT 0,
  bytes_egress bigint NOT NULL DEFAULT 0,
  operations_class_a bigint NOT NULL DEFAULT 0,
  operations_class_b bigint NOT NULL DEFAULT 0,
  object_count bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT storage_usage_daily_bytes_stored_non_negative CHECK (bytes_stored >= 0),
  CONSTRAINT storage_usage_daily_bytes_egress_non_negative CHECK (bytes_egress >= 0),
  CONSTRAINT storage_usage_daily_ops_class_a_non_negative CHECK (operations_class_a >= 0),
  CONSTRAINT storage_usage_daily_ops_class_b_non_negative CHECK (operations_class_b >= 0),
  CONSTRAINT storage_usage_daily_object_count_non_negative CHECK (object_count >= 0)
);
CREATE TABLE IF NOT EXISTS platform.storage_object_references (
  object_id uuid NOT NULL REFERENCES platform.storage_objects(id) ON DELETE CASCADE,
  owner_kind text NOT NULL,
  owner_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT storage_object_references_pkey PRIMARY KEY (object_id, owner_kind, owner_id),
  CONSTRAINT storage_object_references_owner_kind_check CHECK (owner_kind IN ('cms_entry', 'comment', 'doc_service', 'user_avatar', 'workspace_logo', 'platform_generic'))
);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_storage_providers_workspace_kind_bucket_uidx
  ON platform.workspace_storage_providers (workspace_id, provider_kind, bucket)
  WHERE status <> 'disabled';
CREATE UNIQUE INDEX IF NOT EXISTS workspace_storage_providers_workspace_default_uidx
  ON platform.workspace_storage_providers (workspace_id)
  WHERE is_default = true AND status <> 'disabled';
CREATE UNIQUE INDEX IF NOT EXISTS storage_objects_workspace_provider_key_uidx
  ON platform.storage_objects (workspace_id, provider_id, provider_object_key);
CREATE UNIQUE INDEX IF NOT EXISTS storage_object_variants_object_kind_uidx
  ON platform.storage_object_variants (object_id, variant_kind);
CREATE UNIQUE INDEX IF NOT EXISTS storage_usage_daily_workspace_date_provider_uidx
  ON platform.storage_usage_daily (workspace_id, usage_date, provider_id)
  WHERE provider_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS storage_usage_daily_workspace_date_total_uidx
  ON platform.storage_usage_daily (workspace_id, usage_date)
  WHERE provider_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS storage_objects_workspace_sha256_uidx
  ON platform.storage_objects (workspace_id, sha256)
  WHERE sha256 IS NOT NULL AND status IN ('uploaded', 'processing', 'ready');
-- Columns from canonical 20260529090000 migration.
ALTER TABLE platform.storage_processing_jobs ADD COLUMN payload jsonb NOT NULL DEFAULT '{}';
ALTER TABLE platform.storage_processing_jobs ADD COLUMN required boolean NOT NULL DEFAULT true;

-- Canonical 20260528100000 active job uniqueness.
CREATE UNIQUE INDEX IF NOT EXISTS storage_processing_jobs_active_unique_uidx
  ON platform.storage_processing_jobs (object_id, job_kind)
  WHERE status IN ('queued', 'running');
