/**
 * STORAGE-7 — planner tests.
 *
 * Asserts the deterministic mapping from (contentType, compressionRequested,
 * status) to the planned job list.
 */
import { describe, test, expect } from 'bun:test';
import {
  planProcessingJobs,
  planProcessingJobTypes,
} from '../../../../src/actions/handlers/processing/planner';
import { seedObject } from './_fakes';

describe('planProcessingJobs', () => {
  test('always includes a REQUIRED scan_validation job for any uploaded object', () => {
    const o = seedObject({ contentType: 'application/octet-stream', compressionRequested: false });
    const jobs = planProcessingJobs(o);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.jobType).toBe('scan_validation');
    expect(jobs[0]?.required).toBe(true);
  });

  test('returns [] for objects in non-uploaded states', () => {
    for (const status of ['pending_upload', 'processing', 'ready', 'failed', 'deleted'] as const) {
      const o = seedObject({ status });
      expect(planProcessingJobs(o)).toEqual([]);
    }
  });

  test('image with compression -> scan + image_optimize (image_optimize NOT required)', () => {
    const o = seedObject({ contentType: 'image/jpeg', compressionRequested: true });
    const types = planProcessingJobTypes(o);
    expect(types).toEqual(['scan_validation', 'image_optimize']);
    const jobs = planProcessingJobs(o);
    expect(jobs[1]?.required).toBe(false);
  });

  test('image without compression -> scan only', () => {
    const o = seedObject({ contentType: 'image/png', compressionRequested: false });
    expect(planProcessingJobTypes(o)).toEqual(['scan_validation']);
  });

  test('video with compression -> scan + probe + thumbnail + transcode', () => {
    const o = seedObject({ contentType: 'video/mp4', compressionRequested: true });
    const types = planProcessingJobTypes(o);
    expect(types).toEqual(['scan_validation', 'video_probe', 'video_thumbnail', 'video_transcode']);
  });

  test('video_probe is required; thumbnail + transcode are NOT', () => {
    const o = seedObject({ contentType: 'video/mp4', compressionRequested: true });
    const jobs = planProcessingJobs(o);
    const probe = jobs.find((j) => j.jobType === 'video_probe');
    const thumb = jobs.find((j) => j.jobType === 'video_thumbnail');
    const trans = jobs.find((j) => j.jobType === 'video_transcode');
    expect(probe?.required).toBe(true);
    expect(thumb?.required).toBe(false);
    expect(trans?.required).toBe(false);
  });

  test('video without compression -> scan only', () => {
    const o = seedObject({ contentType: 'video/quicktime', compressionRequested: false });
    expect(planProcessingJobTypes(o)).toEqual(['scan_validation']);
  });

  test('safe document (PDF) -> scan + document_preview (not required)', () => {
    const o = seedObject({ contentType: 'application/pdf', compressionRequested: true });
    const jobs = planProcessingJobs(o);
    expect(jobs.map((j) => j.jobType)).toEqual(['scan_validation', 'document_preview']);
    expect(jobs[1]?.required).toBe(false);
  });

  test('all safe document MIMEs yield a document_preview job', () => {
    const safeMimes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.oasis.opendocument.text',
      'application/vnd.oasis.opendocument.spreadsheet',
      'application/vnd.oasis.opendocument.presentation',
      'application/rtf',
    ];
    for (const mime of safeMimes) {
      const o = seedObject({ contentType: mime, compressionRequested: true });
      expect(planProcessingJobTypes(o)).toContain('document_preview');
    }
  });

  test('unsafe / unknown document -> scan only (no preview)', () => {
    const o = seedObject({
      contentType: 'application/x-shockwave-flash',
      compressionRequested: true,
    });
    expect(planProcessingJobTypes(o)).toEqual(['scan_validation']);
  });

  test('audio with compression -> scan only (compression deferred)', () => {
    const o = seedObject({ contentType: 'audio/mpeg', compressionRequested: true });
    expect(planProcessingJobTypes(o)).toEqual(['scan_validation']);
  });

  test('archive with compression -> scan only (never lossy-compress archives)', () => {
    const o = seedObject({ contentType: 'application/zip', compressionRequested: true });
    expect(planProcessingJobTypes(o)).toEqual(['scan_validation']);
  });

  test('text with compression -> scan only', () => {
    const o = seedObject({ contentType: 'text/markdown', compressionRequested: true });
    expect(planProcessingJobTypes(o)).toEqual(['scan_validation']);
  });

  test('document preview is case-insensitive on MIME', () => {
    const o = seedObject({ contentType: 'APPLICATION/PDF', compressionRequested: true });
    expect(planProcessingJobTypes(o)).toEqual(['scan_validation', 'document_preview']);
  });

  test('payload NEVER carries provider config or credentials', () => {
    const o = seedObject({ contentType: 'image/avif', compressionRequested: true });
    const jobs = planProcessingJobs(o);
    for (const j of jobs) {
      const s = JSON.stringify(j.payload);
      expect(s).not.toContain('provider');
      expect(s).not.toContain('endpoint');
      expect(s).not.toContain('region');
      expect(s).not.toContain('bucket');
      expect(s).not.toContain('accessKey');
      expect(s).not.toContain('secretAccess');
      expect(s).not.toContain('credential');
      expect(s).not.toContain('providerObjectKey');
    }
  });

  test('plan output is deterministic across calls', () => {
    const o = seedObject({ contentType: 'video/mp4', compressionRequested: true });
    const a = planProcessingJobs(o);
    const b = planProcessingJobs(o);
    expect(a).toEqual(b);
  });
});
