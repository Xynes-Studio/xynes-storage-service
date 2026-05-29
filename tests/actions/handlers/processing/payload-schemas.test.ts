/**
 * STORAGE-FU-2-FU-2 — per-jobType payload validator unit tests.
 *
 * Covers:
 *   - happy paths for every closed `ProcessingJobType`
 *   - strict-mode rejection of unknown keys
 *   - unknown jobType rejection
 *   - control-char / oversize / non-printable rejection
 *   - error envelope shape (code, statusHint, rejectedKeys)
 *   - regression: hostile values NEVER appear in the error message
 */
import { describe, expect, test } from 'bun:test';
import {
  PayloadValidationError,
  JOB_PAYLOAD_SCHEMAS,
  validateJobPayload,
} from '../../../../src/actions/handlers/processing/payload-schemas';
import type { ProcessingJobType } from '../../../../src/actions/handlers/processing/types';

describe('JOB_PAYLOAD_SCHEMAS — closed-set coverage', () => {
  test('declares a schema for every ProcessingJobType (exhaustiveness)', () => {
    // Type-system check: assigning the const to its declared type
    // already enforces exhaustiveness at compile time. This runtime
    // check guards against accidental `as Record<string, ...>` casts.
    const ALL_TYPES: readonly ProcessingJobType[] = [
      'scan_validation',
      'image_optimize',
      'video_probe',
      'video_thumbnail',
      'video_transcode',
      'document_preview',
    ];
    for (const t of ALL_TYPES) {
      expect(JOB_PAYLOAD_SCHEMAS[t]).toBeDefined();
    }
  });
});

describe('validateJobPayload — happy paths (planner-emitted shapes)', () => {
  test('scan_validation accepts { contentType, byteSize }', () => {
    const out = validateJobPayload('scan_validation', {
      contentType: 'image/png',
      byteSize: 12345,
    });
    expect(out).toEqual({ contentType: 'image/png', byteSize: 12345 });
  });

  test('scan_validation accepts byteSize=0 (zero-byte upload edge case)', () => {
    const out = validateJobPayload('scan_validation', {
      contentType: 'application/octet-stream',
      byteSize: 0,
    });
    expect(out.byteSize).toBe(0);
  });

  test.each([
    'image_optimize',
    'video_probe',
    'video_thumbnail',
    'video_transcode',
    'document_preview',
  ] as const)('%s accepts { contentType } only', (jobType) => {
    const out = validateJobPayload(jobType, { contentType: 'image/png' });
    expect(out).toEqual({ contentType: 'image/png' });
  });
});

describe('validateJobPayload — strict mode rejects hostile keys', () => {
  test('rejects unknown key on scan_validation', () => {
    let thrown: PayloadValidationError | null = null;
    try {
      validateJobPayload('scan_validation', {
        contentType: 'image/png',
        byteSize: 12345,
        providerObjectKey: 'workspaces/ws/secret-path/key',
      });
    } catch (err) {
      thrown = err as PayloadValidationError;
    }
    expect(thrown).toBeInstanceOf(PayloadValidationError);
    expect(thrown?.code).toBe('INVALID_JOB_PAYLOAD');
    expect(thrown?.statusHint).toBe(400);
    expect(thrown?.jobType).toBe('scan_validation');
    expect(thrown?.rejectedKeys).toContain('providerObjectKey');
  });

  test('rejects credential-shaped keys on image_optimize', () => {
    const hostile = {
      contentType: 'image/png',
      accessKeyId: 'AKIA-HOSTILE-LEAK-1234',
      secretAccessKey: 'should-never-touch-the-payload',
    };
    let thrown: PayloadValidationError | null = null;
    try {
      validateJobPayload('image_optimize', hostile);
    } catch (err) {
      thrown = err as PayloadValidationError;
    }
    expect(thrown?.rejectedKeys).toContain('accessKeyId');
    expect(thrown?.rejectedKeys).toContain('secretAccessKey');
    // Defense in depth: hostile VALUES never reach the error message.
    expect(thrown?.message ?? '').not.toContain('AKIA-HOSTILE-LEAK-1234');
    expect(thrown?.message ?? '').not.toContain('should-never-touch-the-payload');
  });

  test('rejects credentialRef + signed URL leak on video_thumbnail', () => {
    const hostile = {
      contentType: 'video/mp4',
      credentialRef: 'secret://leak/credential',
      signedUrl: 'https://example.r2.cloudflarestorage.com/?X-Amz-Signature=DEADBEEF',
    };
    let thrown: PayloadValidationError | null = null;
    try {
      validateJobPayload('video_thumbnail', hostile);
    } catch (err) {
      thrown = err as PayloadValidationError;
    }
    expect(thrown?.rejectedKeys).toContain('credentialRef');
    expect(thrown?.rejectedKeys).toContain('signedUrl');
    expect(thrown?.message ?? '').not.toContain('secret://leak/credential');
    expect(thrown?.message ?? '').not.toContain('X-Amz-Signature=DEADBEEF');
  });

  test('rejects xynes_live_* raw API key smuggled into payload', () => {
    const hostile = {
      contentType: 'video/mp4',
      bearer: 'xynes_live_abc123',
    };
    let thrown: PayloadValidationError | null = null;
    try {
      validateJobPayload('video_transcode', hostile);
    } catch (err) {
      thrown = err as PayloadValidationError;
    }
    expect(thrown?.rejectedKeys).toContain('bearer');
    expect(thrown?.message ?? '').not.toContain('xynes_live_abc123');
  });
});

describe('validateJobPayload — shape mismatches', () => {
  test('rejects missing contentType on every jobType', () => {
    for (const jobType of [
      'image_optimize',
      'video_probe',
      'video_thumbnail',
      'video_transcode',
      'document_preview',
    ] as const) {
      let thrown: PayloadValidationError | null = null;
      try {
        validateJobPayload(jobType, {});
      } catch (err) {
        thrown = err as PayloadValidationError;
      }
      expect(thrown).toBeInstanceOf(PayloadValidationError);
      expect(thrown?.rejectedKeys).toContain('contentType');
    }
  });

  test('rejects non-string contentType', () => {
    let thrown: PayloadValidationError | null = null;
    try {
      validateJobPayload('image_optimize', { contentType: 12345 });
    } catch (err) {
      thrown = err as PayloadValidationError;
    }
    expect(thrown?.rejectedKeys).toContain('contentType');
  });

  test('rejects control characters in contentType (no NUL / newline smuggling)', () => {
    expect(() =>
      validateJobPayload('image_optimize', { contentType: 'image/png\x00malicious' }),
    ).toThrow(PayloadValidationError);
    expect(() =>
      validateJobPayload('image_optimize', { contentType: 'image/png\nX-Inject: header' }),
    ).toThrow(PayloadValidationError);
  });

  test('rejects oversized contentType (> 255 chars)', () => {
    const huge = 'a'.repeat(256);
    expect(() => validateJobPayload('image_optimize', { contentType: huge })).toThrow(
      PayloadValidationError,
    );
  });

  test('scan_validation rejects negative or non-integer byteSize', () => {
    expect(() => validateJobPayload('scan_validation', { contentType: 'a', byteSize: -1 })).toThrow(
      PayloadValidationError,
    );
    expect(() =>
      validateJobPayload('scan_validation', { contentType: 'a', byteSize: 1.5 }),
    ).toThrow(PayloadValidationError);
  });

  test('scan_validation rejects byteSize > 5 GiB cap', () => {
    expect(() =>
      validateJobPayload('scan_validation', {
        contentType: 'a',
        byteSize: 5 * 1024 * 1024 * 1024 + 1,
      }),
    ).toThrow(PayloadValidationError);
  });

  test('null and non-object payloads are rejected', () => {
    expect(() => validateJobPayload('image_optimize', null)).toThrow(PayloadValidationError);
    expect(() => validateJobPayload('image_optimize', 'string-payload')).toThrow(
      PayloadValidationError,
    );
    expect(() => validateJobPayload('image_optimize', 42)).toThrow(PayloadValidationError);
  });
});

describe('validateJobPayload — unknown job type', () => {
  test('rejects unknown jobType with closed-set code', () => {
    let thrown: PayloadValidationError | null = null;
    try {
      validateJobPayload('totally_made_up_kind', { contentType: 'image/png' });
    } catch (err) {
      thrown = err as PayloadValidationError;
    }
    expect(thrown).toBeInstanceOf(PayloadValidationError);
    expect(thrown?.code).toBe('INVALID_JOB_PAYLOAD');
    expect(thrown?.jobType).toBe('totally_made_up_kind');
    // The error must NOT echo the payload — just the unknown-jobType
    // marker.
    expect(thrown?.rejectedKeys).toEqual(['<unknown jobType>']);
    expect(thrown?.message).toContain('totally_made_up_kind');
  });

  test('rejects empty-string jobType', () => {
    let thrown: PayloadValidationError | null = null;
    try {
      validateJobPayload('', { contentType: 'image/png' });
    } catch (err) {
      thrown = err as PayloadValidationError;
    }
    expect(thrown).toBeInstanceOf(PayloadValidationError);
  });
});

describe('PayloadValidationError — envelope contract', () => {
  test('rejectedKeys is frozen (cannot be mutated by callers)', () => {
    const err = new PayloadValidationError('image_optimize', ['providerObjectKey']);
    expect(Object.isFrozen(err.rejectedKeys)).toBe(true);
  });

  test('code + statusHint are stable closed-set values', () => {
    const err = new PayloadValidationError('image_optimize', ['x']);
    expect(err.code).toBe('INVALID_JOB_PAYLOAD');
    expect(err.statusHint).toBe(400);
    expect(err.name).toBe('PayloadValidationError');
  });

  test('empty rejectedKeys produces shape-mismatch message (no key list)', () => {
    const err = new PayloadValidationError('image_optimize', []);
    expect(err.message).toContain('shape mismatch');
    expect(err.message).not.toContain('[]');
  });
});
