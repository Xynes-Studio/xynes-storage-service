/**
 * STORAGE-8 — scan-validation runner unit tests.
 *
 * Required job. Failures flip the parent object to `failed` via the
 * STORAGE-7 aggregator.
 */
import { describe, expect, test } from 'bun:test';
import { createScanValidationRunner } from '../../../../../src/actions/handlers/processing/runners/scan-validation';
import {
  FakeMalwareScanner,
  FakeProviderIO,
  makeBytes,
  seedClaimedJob,
  seedDocumentObject,
  seedImageObject,
  seedVideoObject,
} from './_fakes';
import { seedObject } from '../_fakes';

function build() {
  const providerIO = new FakeProviderIO();
  const scanner = new FakeMalwareScanner();
  const runner = createScanValidationRunner({ providerIO, scanner });
  return { providerIO, scanner, runner };
}

describe('scan-validation runner', () => {
  test('returns {} when scanner verdict is clean', async () => {
    const { providerIO, runner } = build();
    const object = seedImageObject();
    providerIO.preload(object.providerObjectKey, makeBytes(128));
    const out = await runner({ object, job: seedClaimedJob() });
    expect(out).toEqual({});
  });

  test('reads bytes via provider IO (single read per job)', async () => {
    const { providerIO, runner } = build();
    const object = seedImageObject();
    providerIO.preload(object.providerObjectKey, makeBytes(128));
    await runner({ object, job: seedClaimedJob() });
    expect(providerIO.readCount).toBe(1);
  });

  test('returns non-retryable OVER_MAX_BYTES when image exceeds 50 MiB cap', async () => {
    const { runner } = build();
    const object = seedImageObject({ byteSize: 60 * 1024 * 1024 });
    const out = await runner({ object, job: seedClaimedJob() });
    expect(out).toEqual({ errorCode: 'OVER_MAX_BYTES', retryable: false });
  });

  test('returns non-retryable OVER_MAX_BYTES when video exceeds 2 GiB cap', async () => {
    const { runner } = build();
    const object = seedVideoObject({ byteSize: 3 * 1024 * 1024 * 1024 });
    const out = await runner({ object, job: seedClaimedJob() });
    expect(out).toEqual({ errorCode: 'OVER_MAX_BYTES', retryable: false });
  });

  test('returns non-retryable OVER_MAX_BYTES when document exceeds 100 MiB cap', async () => {
    const { runner } = build();
    const object = seedDocumentObject({ byteSize: 120 * 1024 * 1024 });
    const out = await runner({ object, job: seedClaimedJob() });
    expect(out).toEqual({ errorCode: 'OVER_MAX_BYTES', retryable: false });
  });

  test('does not enforce a hard byte cap for "other" content types (audio/archive/text)', async () => {
    const { providerIO, runner } = build();
    const object = seedObject({
      contentType: 'audio/mpeg',
      byteSize: 5 * 1024 * 1024 * 1024,
    });
    providerIO.preload(object.providerObjectKey, makeBytes(16));
    const out = await runner({ object, job: seedClaimedJob() });
    expect(out).toEqual({});
  });

  test('returns non-retryable MALWARE_DETECTED when scanner returns infected', async () => {
    const { providerIO, scanner, runner } = build();
    scanner.verdict = { verdict: 'infected', signature: 'TestSig.123' };
    const object = seedImageObject();
    providerIO.preload(object.providerObjectKey, makeBytes(32));
    const out = await runner({ object, job: seedClaimedJob() });
    expect(out).toEqual({ errorCode: 'MALWARE_DETECTED', retryable: false });
  });

  test('returns RETRYABLE SCANNER_INCONCLUSIVE when scanner returns unknown', async () => {
    const { providerIO, scanner, runner } = build();
    scanner.verdict = { verdict: 'unknown' };
    const object = seedImageObject();
    providerIO.preload(object.providerObjectKey, makeBytes(32));
    const out = await runner({ object, job: seedClaimedJob() });
    expect(out).toEqual({ errorCode: 'SCANNER_INCONCLUSIVE', retryable: true });
  });

  test('returns RETRYABLE PROCESSOR_FAILED when provider read throws', async () => {
    const { providerIO, runner } = build();
    providerIO.throwOnReadOnce = new Error('s3 timeout');
    const object = seedImageObject();
    const out = await runner({ object, job: seedClaimedJob() });
    expect(out).toEqual({ errorCode: 'PROCESSOR_FAILED', retryable: true });
  });

  test('never calls scanner when byte cap rejects first', async () => {
    const { providerIO, scanner, runner } = build();
    providerIO.preload(seedImageObject().providerObjectKey, makeBytes(16));
    const object = seedImageObject({ byteSize: 60 * 1024 * 1024 });
    await runner({ object, job: seedClaimedJob() });
    expect(scanner.scanCount).toBe(0);
    expect(providerIO.readCount).toBe(0);
  });

  test('never embeds the bytes or signature into the errorCode (closed-set only)', async () => {
    const { providerIO, scanner, runner } = build();
    scanner.verdict = { verdict: 'infected', signature: 'EICAR-TEST-FILE' };
    const object = seedImageObject();
    providerIO.preload(object.providerObjectKey, makeBytes(8));
    const out = (await runner({ object, job: seedClaimedJob() })) as {
      errorCode: string;
      retryable: boolean;
    };
    expect(out.errorCode).toBe('MALWARE_DETECTED');
    // Closed-set: the signature name is NEVER part of the surfaced
    // errorCode (defense in depth on the worker redaction layer).
    expect(out.errorCode).not.toContain('EICAR');
  });
});
