/**
 * STORAGE-7 — integration test for the upload-complete -> enqueue hook.
 *
 * Verifies:
 *   1. When `enqueueProcessing` is provided, the complete handler calls
 *      it AFTER markUploaded and forwards the returned jobs to
 *      `processingJobs`.
 *   2. When the callback throws, the upload-complete still succeeds and
 *      `processingJobs` returns [].
 *   3. When the callback is absent (STORAGE-5 default), the response
 *      carries an empty processingJobs array (backward compatibility).
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { createCompleteUploadHandler } from '../../../../src/actions/handlers/uploads/complete';
import { enqueueProcessingForObject } from '../../../../src/actions/handlers/processing/enqueue';
import {
  FakeProviderResolver,
  FakeRepositories,
  TEST_WORKSPACE_ID,
  makeUserCtx,
} from '../uploads/_fakes';
import { FakeObjectStatus, FakeProcessingQueue } from './_fakes';
import type { CompleteUploadSessionResponse } from '../../../../src/actions/handlers/uploads/responses';

const TEST_SESSION_ID = '00000000-0000-4000-8000-700000000001';
const TEST_OBJECT_ID = '00000000-0000-4000-8000-700000000002';

beforeEach(() => {});

function seedPendingSession(repos: FakeRepositories) {
  const now = new Date('2026-05-14T01:00:00.000Z');
  const future = new Date('2026-05-14T01:30:00.000Z');
  repos.seedSession(
    {
      id: TEST_SESSION_ID,
      workspaceId: TEST_WORKSPACE_ID,
      objectId: TEST_OBJECT_ID,
      uploadMethod: 'single',
      providerUploadId: null,
      status: 'pending',
      createdAt: now,
      expiresAt: future,
      completedAt: null,
      abortedAt: null,
      createdBy: null,
    },
    {
      id: TEST_OBJECT_ID,
      workspaceId: TEST_WORKSPACE_ID,
      providerId: '00000000-0000-4000-8000-0000000000a0',
      providerObjectKey: 'workspaces/ws/objects/obj/file.bin',
      filename: 'file.bin',
      contentType: 'image/jpeg',
      byteSize: 1024,
      sha256: null,
      purpose: 'platform_generic',
      visibility: 'private',
      status: 'pending_upload',
      compressionRequested: true,
      createdBy: null,
      createdAt: now,
      updatedAt: now,
      uploadedAt: null,
    },
  );
}

describe('STORAGE-7 wiring — upload-complete → enqueueProcessing', () => {
  test('complete handler invokes enqueueProcessing and forwards jobs', async () => {
    const repos = new FakeRepositories();
    const providers = new FakeProviderResolver();
    seedPendingSession(repos);

    const queue = new FakeProcessingQueue();
    const status = new FakeObjectStatus();
    // Seed the storage-status fake with the same object the upload repo has.
    status.seed({
      id: TEST_OBJECT_ID,
      workspaceId: TEST_WORKSPACE_ID,
      providerId: '00000000-0000-4000-8000-0000000000a0',
      providerObjectKey: 'workspaces/ws/objects/obj/file.bin',
      filename: 'file.bin',
      contentType: 'image/jpeg',
      byteSize: 1024,
      sha256: null,
      purpose: 'platform_generic',
      visibility: 'private',
      status: 'uploaded',
      compressionRequested: true,
      createdBy: null,
      createdAt: new Date('2026-05-14T01:00:00.000Z'),
      updatedAt: new Date('2026-05-14T01:00:00.000Z'),
      uploadedAt: new Date('2026-05-14T01:00:00.000Z'),
    });

    const handler = createCompleteUploadHandler({
      objects: repos.objects,
      sessions: repos.sessions,
      providers,
      now: () => new Date('2026-05-14T01:10:00.000Z'),
      enqueueProcessing: async (input) => {
        const o = status.objects.get(input.objectId);
        if (!o) return [];
        const result = await enqueueProcessingForObject({ queue, status }, o);
        return result.jobs;
      },
    });

    const res = (await handler(
      { operation: 'complete', uploadId: TEST_SESSION_ID },
      makeUserCtx(),
    )) as CompleteUploadSessionResponse;

    expect(res.processingJobs).toHaveLength(2); // scan + image_optimize
    expect(queue.enqueueBatchCount).toBe(1);
  });

  test('thrown callback does NOT undo the upload-complete success', async () => {
    const repos = new FakeRepositories();
    const providers = new FakeProviderResolver();
    seedPendingSession(repos);

    const handler = createCompleteUploadHandler({
      objects: repos.objects,
      sessions: repos.sessions,
      providers,
      now: () => new Date('2026-05-14T01:10:00.000Z'),
      enqueueProcessing: async () => {
        throw new Error('queue offline');
      },
    });

    const res = (await handler(
      { operation: 'complete', uploadId: TEST_SESSION_ID },
      makeUserCtx(),
    )) as CompleteUploadSessionResponse;

    // Upload still completes
    expect(res.session.status).toBe('completed');
    expect(res.object.status).toBe('uploaded');
    // ProcessingJobs falls back to []
    expect(res.processingJobs).toEqual([]);
  });

  test('absent callback returns empty processingJobs (STORAGE-5 default)', async () => {
    const repos = new FakeRepositories();
    const providers = new FakeProviderResolver();
    seedPendingSession(repos);

    const handler = createCompleteUploadHandler({
      objects: repos.objects,
      sessions: repos.sessions,
      providers,
      now: () => new Date('2026-05-14T01:10:00.000Z'),
    });

    const res = (await handler(
      { operation: 'complete', uploadId: TEST_SESSION_ID },
      makeUserCtx(),
    )) as CompleteUploadSessionResponse;

    expect(res.processingJobs).toEqual([]);
  });
});
