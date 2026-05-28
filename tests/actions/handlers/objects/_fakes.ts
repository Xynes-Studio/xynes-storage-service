/**
 * STORAGE-6 — shared test fakes for the objects handler family.
 *
 * Builds on the STORAGE-5 fakes (`FakeStorageAdapter`, `FakeRepositories`,
 * deterministic ids, user/api_key actor contexts) but adds:
 *
 *   - `ExtendedFakeObjectRepository`     — implements list / soft-delete / find-by-id.
 *   - `FakeVariantRepository`            — variant rows per object.
 *   - `FakeProcessingJobRepository`      — processing job rows per object.
 *   - `FakeUsageRepository`              — pre-aggregated daily usage rows.
 *   - `ExtendedFakeProviderResolver`     — resolveDefault + resolveByProviderId.
 *
 * The STORAGE-5 fakes already cover atomic create + state transitions for
 * upload sessions; STORAGE-6 deliberately KEEPS those fakes untouched and
 * defines its own object repo so the two test families don't share
 * mutable state.
 *
 * Every adapter call is captured in `adapter.calls` so redaction tests can
 * verify the handler never echoes provider config back to the caller.
 */
import {
  FakeReferencesRepository,
  FakeStorageAdapter,
  TEST_WORKSPACE_ID,
  TEST_USER_ID,
  TEST_API_KEY_ID,
  makeUserCtx,
  makeApiKeyCtx,
} from '../uploads/_fakes';
import type { ProviderKind } from '../../../../src/infra/providers/types';
import type {
  ExtendedStorageObjectRepository,
  ExtendedStorageProviderResolver,
  ListObjectsRepoInput,
  ListObjectsRepoResult,
  ObjectsHandlerDependencies,
  ResolvedProvider,
  StorageObjectRecord,
  StorageObjectVariantRecord,
  StorageProcessingJobRecord,
  StorageUsageDailyRecord,
  StorageUsageRepository,
  StorageVariantRepository,
  StorageProcessingJobRepository,
} from '../../../../src/actions/handlers/objects/types';

// Re-export STORAGE-5 primitives so test files import from one place.
export {
  FakeReferencesRepository,
  FakeStorageAdapter,
  TEST_WORKSPACE_ID,
  TEST_USER_ID,
  TEST_API_KEY_ID,
  makeUserCtx,
  makeApiKeyCtx,
};

export const OTHER_WORKSPACE_ID = '00000000-0000-4000-8000-000000999001';

/**
 * Deterministic id factory dedicated to STORAGE-6 fixtures (separate
 * counter from STORAGE-5's so the test ids don't collide).
 */
function makeIdSeed(prefix: string) {
  let counter = 0;
  return () => {
    counter += 1;
    const hex = counter.toString(16).padStart(12, '0');
    return `00000000-0000-4000-8000-${prefix}${hex.slice(prefix.length)}`;
  };
}

export const nextObjectId = makeIdSeed('aa');
export const nextVariantId = makeIdSeed('cc');
export const nextJobId = makeIdSeed('dd');

// ── Object factories ──────────────────────────────────────────────────────

export interface MakeObjectInput {
  readonly id?: string;
  readonly workspaceId?: string;
  readonly providerId?: string;
  readonly providerObjectKey?: string;
  readonly filename?: string;
  readonly contentType?: string;
  readonly byteSize?: number;
  readonly sha256?: string | null;
  readonly purpose?: string;
  readonly visibility?: 'private' | 'public';
  readonly status?: StorageObjectRecord['status'];
  readonly compressionRequested?: boolean;
  readonly createdBy?: string | null;
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
  readonly uploadedAt?: Date | null;
}

export function makeObject(input: MakeObjectInput = {}): StorageObjectRecord {
  const id = input.id ?? nextObjectId();
  const workspaceId = input.workspaceId ?? TEST_WORKSPACE_ID;
  const createdAt = input.createdAt ?? new Date('2026-05-13T00:00:00.000Z');
  return {
    id,
    workspaceId,
    providerId: input.providerId ?? '00000000-0000-4000-8000-0000000000a0',
    providerObjectKey:
      input.providerObjectKey ?? `workspaces/${workspaceId}/objects/${id}/file.bin`,
    filename: input.filename ?? 'file.bin',
    contentType: input.contentType ?? 'application/octet-stream',
    byteSize: input.byteSize ?? 4096,
    sha256: input.sha256 ?? null,
    purpose: input.purpose ?? 'platform_generic',
    visibility: input.visibility ?? 'private',
    status: input.status ?? 'ready',
    compressionRequested: input.compressionRequested ?? true,
    createdBy: input.createdBy ?? null,
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
    uploadedAt: input.uploadedAt === undefined ? createdAt : input.uploadedAt,
  };
}

export function makeVariant(
  input: {
    objectId: string;
    variantKey?: string;
    contentType?: string;
    byteSize?: number;
    status?: 'pending' | 'ready' | 'failed';
  } & { id?: string },
): StorageObjectVariantRecord {
  const now = new Date('2026-05-13T01:00:00.000Z');
  return {
    id: input.id ?? nextVariantId(),
    objectId: input.objectId,
    variantKey: input.variantKey ?? 'thumb_256',
    contentType: input.contentType ?? 'image/webp',
    byteSize: input.byteSize ?? 12_345,
    status: input.status ?? 'ready',
    createdAt: now,
    updatedAt: now,
  };
}

export function makeJob(input: {
  objectId: string;
  id?: string;
  jobType?: string;
  status?: StorageProcessingJobRecord['status'];
  attempts?: number;
  errorCode?: string | null;
  required?: boolean;
}): StorageProcessingJobRecord {
  const now = new Date('2026-05-13T01:30:00.000Z');
  return {
    id: input.id ?? nextJobId(),
    objectId: input.objectId,
    jobType: input.jobType ?? 'image_optimize',
    status: input.status ?? 'queued',
    attempts: input.attempts ?? 0,
    errorCode: input.errorCode ?? null,
    required: input.required ?? false,
    scheduledAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

// ── Extended object repository ────────────────────────────────────────────

export class ExtendedFakeObjectRepository implements ExtendedStorageObjectRepository {
  public readonly objects = new Map<string, StorageObjectRecord>();

  /** Override: if set, listForWorkspace yields these args back to the test. */
  public lastListInput: ListObjectsRepoInput | null = null;
  /** Override: if set, listForWorkspace returns this directly. */
  public listResultOverride: ListObjectsRepoResult | null = null;
  /** When true, softDeleteForWorkspace returns null even if the row exists. */
  public failSoftDelete = false;

  seed(...records: StorageObjectRecord[]): void {
    for (const r of records) this.objects.set(r.id, r);
  }

  async findByIdForWorkspace({
    objectId,
    workspaceId,
  }: {
    objectId: string;
    workspaceId: string;
  }): Promise<StorageObjectRecord | null> {
    const o = this.objects.get(objectId);
    if (!o || o.workspaceId !== workspaceId) return null;
    return o;
  }

  async listForWorkspace(input: ListObjectsRepoInput): Promise<ListObjectsRepoResult> {
    this.lastListInput = input;
    if (this.listResultOverride) return this.listResultOverride;
    // In-memory filter — keeps the default fake honest about not returning deleted rows.
    const all = [...this.objects.values()]
      .filter((o) => o.workspaceId === input.workspaceId)
      .filter((o) => o.status !== 'deleted')
      .filter((o) => !input.filters.purpose || o.purpose === input.filters.purpose)
      .filter((o) => !input.filters.status || o.status === input.filters.status)
      .filter((o) => !input.filters.createdBy || o.createdBy === input.filters.createdBy)
      .filter((o) => !input.filters.createdAfter || o.createdAt >= input.filters.createdAfter)
      .filter((o) => !input.filters.createdBefore || o.createdAt <= input.filters.createdBefore)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const items = all.slice(0, input.limit);
    const nextCursor = all.length > input.limit ? `cursor-${all.length}` : null;
    return { items, nextCursor };
  }

  async softDeleteForWorkspace({
    objectId,
    workspaceId,
    now,
  }: {
    objectId: string;
    workspaceId: string;
    now: Date;
  }): Promise<StorageObjectRecord | null> {
    if (this.failSoftDelete) return null;
    const o = this.objects.get(objectId);
    if (!o || o.workspaceId !== workspaceId) return null;
    if (o.status === 'deleted') return o;
    const updated: StorageObjectRecord = {
      ...o,
      status: 'deleted',
      updatedAt: now,
    };
    this.objects.set(objectId, updated);
    return updated;
  }

  /** Test helper: force-mutate a row (simulates concurrent state changes). */
  setStatus(objectId: string, status: StorageObjectRecord['status']): void {
    const o = this.objects.get(objectId);
    if (!o) return;
    this.objects.set(objectId, { ...o, status });
  }
}

// ── Variant + processing job + usage fakes ────────────────────────────────

export class FakeVariantRepository implements StorageVariantRepository {
  private readonly map = new Map<string, StorageObjectVariantRecord[]>();
  public lastInput: { objectId: string; workspaceId: string } | null = null;

  seed(objectId: string, ...variants: StorageObjectVariantRecord[]): void {
    this.map.set(objectId, variants);
  }

  async listForObject(input: {
    objectId: string;
    workspaceId: string;
  }): Promise<readonly StorageObjectVariantRecord[]> {
    this.lastInput = input;
    return this.map.get(input.objectId) ?? [];
  }
}

export class FakeProcessingJobRepository implements StorageProcessingJobRepository {
  private readonly map = new Map<string, StorageProcessingJobRecord[]>();
  public lastInput: { objectId: string; workspaceId: string } | null = null;

  seed(objectId: string, ...jobs: StorageProcessingJobRecord[]): void {
    this.map.set(objectId, jobs);
  }

  async listForObject(input: {
    objectId: string;
    workspaceId: string;
  }): Promise<readonly StorageProcessingJobRecord[]> {
    this.lastInput = input;
    return this.map.get(input.objectId) ?? [];
  }
}

export class FakeUsageRepository implements StorageUsageRepository {
  public rows: StorageUsageDailyRecord[] = [];
  public lastInput: { workspaceId: string; fromDate: string; toDate: string } | null = null;

  seed(...rows: StorageUsageDailyRecord[]): void {
    this.rows.push(...rows);
  }

  async readDailyForWorkspace(input: {
    workspaceId: string;
    fromDate: string;
    toDate: string;
  }): Promise<readonly StorageUsageDailyRecord[]> {
    this.lastInput = input;
    // Caller scopes by workspaceId implicitly via the fake — we return seeded rows.
    return this.rows.filter((r) => r.date >= input.fromDate && r.date <= input.toDate);
  }
}

// ── Extended provider resolver ────────────────────────────────────────────

export class ExtendedFakeProviderResolver implements ExtendedStorageProviderResolver {
  public readonly adapter: FakeStorageAdapter;
  public readonly providerId: string;
  public resolveDefaultCount = 0;
  public resolveByProviderIdCount = 0;
  /** When true, resolveDefaultForWorkspace returns null. */
  public defaultUnavailable = false;
  /** When set, resolveByProviderIdForWorkspace returns null for these ids. */
  public unavailableProviderIds = new Set<string>();

  constructor(
    options: {
      providerId?: string;
      providerKind?: ProviderKind;
      adapter?: FakeStorageAdapter;
    } = {},
  ) {
    this.providerId = options.providerId ?? '00000000-0000-4000-8000-0000000000a0';
    this.adapter = options.adapter ?? new FakeStorageAdapter(options.providerKind);
  }

  async resolveDefaultForWorkspace(_workspaceId: string): Promise<ResolvedProvider | null> {
    this.resolveDefaultCount += 1;
    if (this.defaultUnavailable) return null;
    return {
      providerId: this.providerId,
      providerKind: this.adapter.providerKind,
      adapter: this.adapter,
    };
  }

  async resolveByProviderIdForWorkspace({
    providerId,
  }: {
    workspaceId: string;
    providerId: string;
  }): Promise<ResolvedProvider | null> {
    this.resolveByProviderIdCount += 1;
    if (this.unavailableProviderIds.has(providerId)) return null;
    return {
      providerId,
      providerKind: this.adapter.providerKind,
      adapter: this.adapter,
    };
  }
}

// ── Aggregate deps builder ────────────────────────────────────────────────

export interface DepsOverrides {
  readonly objects?: ExtendedFakeObjectRepository;
  readonly variants?: FakeVariantRepository;
  readonly jobs?: FakeProcessingJobRepository;
  readonly usage?: FakeUsageRepository;
  readonly providers?: ExtendedFakeProviderResolver;
  readonly references?: FakeReferencesRepository | null;
  readonly now?: () => Date;
  readonly defaultDownloadTtlSeconds?: number;
  readonly defaultListLimit?: number;
}

export function makeObjectsDeps(overrides: DepsOverrides = {}): ObjectsHandlerDependencies & {
  objects: ExtendedFakeObjectRepository;
  variants: FakeVariantRepository;
  jobs: FakeProcessingJobRepository;
  usage: FakeUsageRepository;
  providers: ExtendedFakeProviderResolver;
  /**
   * Test-only accessor for the references fake. Separate name from the
   * `ObjectsHandlerDependencies.references?` slot so the handler still
   * sees `undefined` when callers pass `references: null` (legacy
   * STORAGE-6 path).
   */
  referencesFake: FakeReferencesRepository | null;
} {
  const objects = overrides.objects ?? new ExtendedFakeObjectRepository();
  const variants = overrides.variants ?? new FakeVariantRepository();
  const jobs = overrides.jobs ?? new FakeProcessingJobRepository();
  const usage = overrides.usage ?? new FakeUsageRepository();
  const providers = overrides.providers ?? new ExtendedFakeProviderResolver();
  // DEDUP-2: default to `null` so STORAGE-6 tests keep their byte-for-byte
  // posture. Tests that exercise reference-counted delete pass an explicit
  // `FakeReferencesRepository` instance.
  const references = overrides.references === undefined ? null : overrides.references;
  return {
    objects,
    variants,
    jobs,
    usage,
    providers,
    references: references ?? undefined,
    now: overrides.now,
    defaultDownloadTtlSeconds: overrides.defaultDownloadTtlSeconds,
    defaultListLimit: overrides.defaultListLimit,
    referencesFake: references,
  };
}
