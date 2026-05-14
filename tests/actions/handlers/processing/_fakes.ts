/**
 * STORAGE-7 — shared test fakes for processing planner, enqueue, worker,
 * and retry handler tests.
 *
 * - `FakeProcessingQueue` implements `ProcessingJobQueueRepository` with
 *   an in-memory queue, configurable failure modes, and call-spy
 *   counters.
 * - `FakeObjectStatus` implements `StorageObjectStatusRepository`.
 * - `FakeFindObject` is the worker-side object lookup.
 * - `seedObject` builds a `StorageObjectRecord` with sensible defaults
 *   so each test can override one or two fields.
 */
import type {
  ClaimedJob,
  EnqueueJobInput,
  MarkJobFailedInput,
  ProcessingJobQueueRepository,
  StorageObjectStatusRepository,
} from '../../../../src/actions/handlers/processing/types';
import type {
  ObjectStatus,
  StorageObjectRecord,
  StorageProcessingJobRecord,
} from '../../../../src/actions/handlers/objects/types';

export const TEST_WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';
export const TEST_USER_ID = '00000000-0000-4000-8000-000000000002';
export const TEST_API_KEY_ID = '00000000-0000-4000-8000-000000000003';

let objectIdCounter = 0;
let jobIdCounter = 0;
export function nextObjectId(): string {
  objectIdCounter += 1;
  return `00000000-0000-4000-8000-1000${String(objectIdCounter).padStart(8, '0')}`;
}
export function nextJobId(): string {
  jobIdCounter += 1;
  return `00000000-0000-4000-8000-2000${String(jobIdCounter).padStart(8, '0')}`;
}
export function resetIds(): void {
  objectIdCounter = 0;
  jobIdCounter = 0;
}

export function seedObject(overrides: Partial<StorageObjectRecord> = {}): StorageObjectRecord {
  const now = new Date('2026-05-14T01:00:00.000Z');
  return {
    id: overrides.id ?? nextObjectId(),
    workspaceId: overrides.workspaceId ?? TEST_WORKSPACE_ID,
    providerId: overrides.providerId ?? '00000000-0000-4000-8000-0000000000a0',
    providerObjectKey: overrides.providerObjectKey ?? 'workspaces/ws/objects/obj/file.bin',
    filename: overrides.filename ?? 'file.bin',
    contentType: overrides.contentType ?? 'image/jpeg',
    byteSize: overrides.byteSize ?? 1024,
    sha256: overrides.sha256 ?? null,
    purpose: overrides.purpose ?? 'platform_generic',
    visibility: overrides.visibility ?? 'private',
    status: overrides.status ?? 'uploaded',
    compressionRequested: overrides.compressionRequested ?? true,
    createdBy: overrides.createdBy ?? null,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    uploadedAt: overrides.uploadedAt ?? now,
  };
}

export function makeUserCtx(overrides: Partial<{ workspaceId: string; userId: string }> = {}) {
  const userId = overrides.userId ?? TEST_USER_ID;
  return {
    workspaceId: overrides.workspaceId ?? TEST_WORKSPACE_ID,
    requestId: 'req-test-storage-7',
    actor: { kind: 'user' as const, userId },
    userId,
  };
}

export function makeApiKeyCtx(overrides: Partial<{ workspaceId: string }> = {}) {
  return {
    workspaceId: overrides.workspaceId ?? TEST_WORKSPACE_ID,
    requestId: 'req-test-storage-7',
    actor: {
      kind: 'api_key' as const,
      apiKeyId: TEST_API_KEY_ID,
      keyPrefix: 'aabbccdd',
    },
  };
}

// ── FakeProcessingQueue ────────────────────────────────────────────────────

interface QueueRow extends StorageProcessingJobRecord {
  payload: Readonly<Record<string, unknown>>;
  maxAttempts: number;
}

export class FakeProcessingQueue implements ProcessingJobQueueRepository {
  private readonly rows = new Map<string, QueueRow>();
  public claimNextCount = 0;
  public enqueueBatchCount = 0;
  public markSucceededCount = 0;
  public markFailedCalls: MarkJobFailedInput[] = [];
  public requeueCount = 0;
  /** If true, claimNextQueuedJob throws to simulate a DB outage. */
  public throwOnClaim = false;
  /** Override per test. */
  public maxAttemptsDefault = 3;

  async enqueueBatch(
    input: ReadonlyArray<EnqueueJobInput>,
  ): Promise<ReadonlyArray<StorageProcessingJobRecord>> {
    this.enqueueBatchCount += 1;
    const out: QueueRow[] = [];
    for (const inp of input) {
      // Idempotency: same (objectId, jobType) in non-terminal state -> reject.
      for (const existing of this.rows.values()) {
        if (
          existing.objectId === inp.objectId &&
          existing.jobType === inp.jobType &&
          (existing.status === 'queued' || existing.status === 'running')
        ) {
          throw new Error(`Duplicate non-terminal job for ${inp.objectId}/${inp.jobType}`);
        }
      }
      const row: QueueRow = {
        id: inp.id,
        objectId: inp.objectId,
        jobType: inp.jobType,
        status: 'queued',
        attempts: 0,
        errorCode: null,
        required: inp.required,
        scheduledAt: inp.scheduledAt,
        createdAt: inp.scheduledAt,
        updatedAt: inp.scheduledAt,
        payload: inp.payload,
        maxAttempts: this.maxAttemptsDefault,
      };
      this.rows.set(row.id, row);
      out.push(row);
    }
    return out;
  }

  async listForObject(input: {
    objectId: string;
    workspaceId: string;
  }): Promise<ReadonlyArray<StorageProcessingJobRecord>> {
    void input.workspaceId;
    return [...this.rows.values()].filter((r) => r.objectId === input.objectId).map(stripPayload);
  }

  async claimNextQueuedJob(input: {
    now: Date;
    workspaceAllowlist?: ReadonlyArray<string>;
  }): Promise<ClaimedJob | null> {
    this.claimNextCount += 1;
    if (this.throwOnClaim) throw new Error('queue offline');
    const due = [...this.rows.values()]
      .filter(
        (r) =>
          r.status === 'queued' &&
          r.scheduledAt.getTime() <= input.now.getTime() &&
          (!input.workspaceAllowlist ||
            input.workspaceAllowlist.length === 0 ||
            input.workspaceAllowlist.includes(this.workspaceOf(r.objectId))),
      )
      .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
    const next = due[0];
    if (!next) return null;
    const claimedRow: QueueRow = {
      ...next,
      status: 'running',
      attempts: next.attempts + 1,
      updatedAt: input.now,
    };
    this.rows.set(claimedRow.id, claimedRow);
    return {
      id: claimedRow.id,
      objectId: claimedRow.objectId,
      workspaceId: this.workspaceOf(claimedRow.objectId),
      jobType: claimedRow.jobType as ClaimedJob['jobType'],
      required: claimedRow.required,
      payload: claimedRow.payload,
      attempts: claimedRow.attempts,
      maxAttempts: claimedRow.maxAttempts,
    };
  }

  async markSucceeded(input: { jobId: string; now: Date }) {
    this.markSucceededCount += 1;
    const r = this.rows.get(input.jobId);
    if (!r) return null;
    const updated: QueueRow = {
      ...r,
      status: 'succeeded',
      errorCode: null,
      updatedAt: input.now,
    };
    this.rows.set(updated.id, updated);
    return stripPayload(updated);
  }

  async markFailed(input: MarkJobFailedInput) {
    this.markFailedCalls.push(input);
    const r = this.rows.get(input.jobId);
    if (!r) return null;
    const updated: QueueRow = input.terminal
      ? {
          ...r,
          status: 'failed',
          errorCode: input.errorCode,
          updatedAt: input.now,
        }
      : {
          ...r,
          status: 'queued',
          errorCode: input.errorCode,
          scheduledAt: input.nextScheduledAt ?? new Date(input.now.getTime() + 1000),
          updatedAt: input.now,
        };
    this.rows.set(updated.id, updated);
    return stripPayload(updated);
  }

  async requeueFailedForObject(input: { objectId: string; workspaceId: string; now: Date }) {
    this.requeueCount += 1;
    const out: StorageProcessingJobRecord[] = [];
    for (const r of this.rows.values()) {
      if (r.objectId === input.objectId && r.status === 'failed') {
        const updated: QueueRow = {
          ...r,
          status: 'queued',
          attempts: 0,
          errorCode: null,
          scheduledAt: input.now,
          updatedAt: input.now,
        };
        this.rows.set(updated.id, updated);
        out.push(stripPayload(updated));
      }
    }
    return out;
  }

  // ── Test helpers ─────────────────────────────────────────────────────────
  private readonly workspaceMap = new Map<string, string>();
  bindObjectToWorkspace(objectId: string, workspaceId: string): void {
    this.workspaceMap.set(objectId, workspaceId);
  }
  private workspaceOf(objectId: string): string {
    return this.workspaceMap.get(objectId) ?? TEST_WORKSPACE_ID;
  }
  /** Direct read for assertions. */
  getRow(id: string): QueueRow | undefined {
    return this.rows.get(id);
  }
  /** Snapshot for assertions. */
  snapshot(): StorageProcessingJobRecord[] {
    return [...this.rows.values()].map(stripPayload);
  }
  /** Force-seed a row for state tests. */
  seed(row: Partial<QueueRow> & { id: string; objectId: string; jobType: string }): void {
    const now = new Date('2026-05-14T01:00:00.000Z');
    const full: QueueRow = {
      id: row.id,
      objectId: row.objectId,
      jobType: row.jobType,
      status: row.status ?? 'queued',
      attempts: row.attempts ?? 0,
      errorCode: row.errorCode ?? null,
      required: row.required ?? false,
      scheduledAt: row.scheduledAt ?? now,
      createdAt: row.createdAt ?? now,
      updatedAt: row.updatedAt ?? now,
      payload: row.payload ?? {},
      maxAttempts: row.maxAttempts ?? this.maxAttemptsDefault,
    };
    this.rows.set(full.id, full);
  }
}

function stripPayload(row: QueueRow): StorageProcessingJobRecord {
  return {
    id: row.id,
    objectId: row.objectId,
    jobType: row.jobType,
    status: row.status,
    attempts: row.attempts,
    errorCode: row.errorCode,
    required: row.required,
    scheduledAt: row.scheduledAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ── FakeObjectStatus ───────────────────────────────────────────────────────

export class FakeObjectStatus implements StorageObjectStatusRepository {
  public readonly objects = new Map<string, StorageObjectRecord>();
  public calls: Array<{ objectId: string; workspaceId: string; nextStatus: ObjectStatus }> = [];
  public throwOnce = false;

  seed(o: StorageObjectRecord): void {
    this.objects.set(o.id, o);
  }

  async updateAggregateStatus(input: {
    objectId: string;
    workspaceId: string;
    nextStatus: 'processing' | 'ready' | 'failed';
    now: Date;
  }) {
    this.calls.push({
      objectId: input.objectId,
      workspaceId: input.workspaceId,
      nextStatus: input.nextStatus,
    });
    if (this.throwOnce) {
      this.throwOnce = false;
      throw new Error('status repo offline');
    }
    const o = this.objects.get(input.objectId);
    if (!o || o.workspaceId !== input.workspaceId) return null;
    if (o.status === 'deleted') return null;
    const updated: StorageObjectRecord = { ...o, status: input.nextStatus, updatedAt: input.now };
    this.objects.set(o.id, updated);
    return updated;
  }
}

// ── FakeFindObject ─────────────────────────────────────────────────────────

export function makeFindObject(status: FakeObjectStatus) {
  return async (input: { objectId: string; workspaceId: string }) => {
    const o = status.objects.get(input.objectId);
    if (!o || o.workspaceId !== input.workspaceId) return null;
    return o;
  };
}
