/**
 * STORAGE-6 — usage handler tests.
 *
 * Covers:
 *   - Happy path with seeded daily rows.
 *   - Defaults to last 30 days when `from` / `to` omitted.
 *   - Refuses ranges over MAX_USAGE_RANGE_DAYS.
 *   - Refuses `from > to`.
 *   - Collapses per-provider rows for the same date (no providerKind leaks).
 *   - Schema rejects malformed dates BEFORE the handler runs.
 *   - Aggregation totals.
 *   - Response shape never carries providerKind / etc.
 */
import { describe, expect, test } from 'bun:test';
import { ValidationError } from '../../../../src/actions/errors';
import { createUsageReadHandler } from '../../../../src/actions/handlers/objects/usage';
import { MAX_USAGE_RANGE_DAYS } from '../../../../src/actions/handlers/objects/schemas';
import type { StorageUsageDailyRecord } from '../../../../src/actions/handlers/objects/types';
import { FakeUsageRepository, makeObjectsDeps, makeUserCtx } from './_fakes';

const FORBIDDEN = ['provider_kind', 'providerKind', 'endpoint', 'region', 'bucket'];

function row(input: Partial<StorageUsageDailyRecord> & { date: string }): StorageUsageDailyRecord {
  return {
    date: input.date,
    bytesStored: input.bytesStored ?? 0,
    bytesEgress: input.bytesEgress ?? 0,
    classAOperations: input.classAOperations ?? 0,
    classBOperations: input.classBOperations ?? 0,
    providerKind: input.providerKind ?? 'r2',
  };
}

describe('usageReadHandler — defaults', () => {
  test('defaults to a 30-day window ending today', async () => {
    const usage = new FakeUsageRepository();
    const now = () => new Date('2026-05-13T12:00:00.000Z');
    const res = await createUsageReadHandler(makeObjectsDeps({ usage, now }))(
      { operation: 'usage' },
      makeUserCtx(),
    );
    expect(res.to).toBe('2026-05-13');
    expect(res.from).toBe('2026-04-14'); // 30 days ending 2026-05-13 inclusive.
    expect(usage.lastInput?.fromDate).toBe('2026-04-14');
    expect(usage.lastInput?.toDate).toBe('2026-05-13');
  });

  test('respects explicit from / to', async () => {
    const usage = new FakeUsageRepository();
    const now = () => new Date('2026-05-13T12:00:00.000Z');
    const res = await createUsageReadHandler(makeObjectsDeps({ usage, now }))(
      { operation: 'usage', from: '2026-05-01', to: '2026-05-07' },
      makeUserCtx(),
    );
    expect(res.from).toBe('2026-05-01');
    expect(res.to).toBe('2026-05-07');
  });
});

describe('usageReadHandler — happy paths', () => {
  test('returns daily entries + totals', async () => {
    const usage = new FakeUsageRepository();
    usage.seed(
      row({
        date: '2026-05-01',
        bytesStored: 100,
        bytesEgress: 50,
        classAOperations: 3,
        classBOperations: 7,
      }),
      row({
        date: '2026-05-02',
        bytesStored: 200,
        bytesEgress: 25,
        classAOperations: 1,
        classBOperations: 4,
      }),
    );
    const now = () => new Date('2026-05-13T12:00:00.000Z');
    const res = await createUsageReadHandler(makeObjectsDeps({ usage, now }))(
      { operation: 'usage', from: '2026-05-01', to: '2026-05-13' },
      makeUserCtx(),
    );
    expect(res.daily.length).toBe(2);
    expect(res.daily[0].date).toBe('2026-05-01');
    expect(res.daily[1].date).toBe('2026-05-02');
    expect(res.totals.bytesStored).toBe(300);
    expect(res.totals.bytesEgress).toBe(75);
    expect(res.totals.classAOperations).toBe(4);
    expect(res.totals.classBOperations).toBe(11);
  });

  test('collapses per-provider rows for the same date — takes max for stored, sum for ops/egress', async () => {
    const usage = new FakeUsageRepository();
    usage.seed(
      row({
        date: '2026-05-01',
        bytesStored: 100,
        bytesEgress: 5,
        classAOperations: 1,
        providerKind: 'r2',
      }),
      row({
        date: '2026-05-01',
        bytesStored: 80,
        bytesEgress: 3,
        classAOperations: 2,
        providerKind: 'b2',
      }),
    );
    const now = () => new Date('2026-05-13T12:00:00.000Z');
    const res = await createUsageReadHandler(makeObjectsDeps({ usage, now }))(
      { operation: 'usage', from: '2026-05-01', to: '2026-05-13' },
      makeUserCtx(),
    );
    expect(res.daily.length).toBe(1);
    expect(res.daily[0].bytesStored).toBe(100); // max across providers
    expect(res.daily[0].bytesEgress).toBe(8); // sum across providers
    expect(res.daily[0].classAOperations).toBe(3);
  });

  test('returns empty daily list when no rows in window', async () => {
    const usage = new FakeUsageRepository();
    const now = () => new Date('2026-05-13T12:00:00.000Z');
    const res = await createUsageReadHandler(makeObjectsDeps({ usage, now }))(
      { operation: 'usage', from: '2026-05-01', to: '2026-05-07' },
      makeUserCtx(),
    );
    expect(res.daily.length).toBe(0);
    expect(res.totals.bytesStored).toBe(0);
  });
});

describe('usageReadHandler — range guards', () => {
  test('refuses from > to', async () => {
    await expect(
      createUsageReadHandler(makeObjectsDeps())(
        { operation: 'usage', from: '2026-05-13', to: '2026-05-01' },
        makeUserCtx(),
      ),
    ).rejects.toMatchObject({
      name: 'ValidationError',
      message: '`from` must be on or before `to`',
    });
  });

  test('refuses ranges over MAX_USAGE_RANGE_DAYS', async () => {
    await expect(
      createUsageReadHandler(makeObjectsDeps())(
        { operation: 'usage', from: '2025-01-01', to: '2026-12-31' },
        makeUserCtx(),
      ),
    ).rejects.toMatchObject({
      name: 'ValidationError',
      message: `Usage range exceeds the ${MAX_USAGE_RANGE_DAYS}-day maximum`,
    });
  });
});

describe('usageReadHandler — schema validation', () => {
  test('rejects unknown field', async () => {
    await expect(
      createUsageReadHandler(makeObjectsDeps())(
        { operation: 'usage', granularity: 'hour' },
        makeUserCtx(),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('rejects non-date "from"', async () => {
    await expect(
      createUsageReadHandler(makeObjectsDeps())(
        { operation: 'usage', from: 'yesterday' },
        makeUserCtx(),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('usageReadHandler — response shape', () => {
  test('never echoes providerKind / endpoint / region / bucket', async () => {
    const usage = new FakeUsageRepository();
    usage.seed(
      row({ date: '2026-05-01', bytesStored: 1, providerKind: 'r2' }),
      row({ date: '2026-05-02', bytesStored: 2, providerKind: 'b2' }),
      row({ date: '2026-05-03', bytesStored: 3, providerKind: 'idrive_e2' }),
      row({ date: '2026-05-04', bytesStored: 4, providerKind: 'aws_s3' }),
      row({ date: '2026-05-05', bytesStored: 5, providerKind: 'minio' }),
    );
    const now = () => new Date('2026-05-13T12:00:00.000Z');
    const res = await createUsageReadHandler(makeObjectsDeps({ usage, now }))(
      { operation: 'usage', from: '2026-05-01', to: '2026-05-13' },
      makeUserCtx(),
    );
    const json = JSON.stringify(res);
    for (const f of FORBIDDEN) expect(json).not.toContain(`"${f}"`);
    for (const kind of ['"r2"', '"b2"', '"idrive_e2"', '"aws_s3"', '"minio"']) {
      expect(json).not.toContain(kind);
    }
  });
});
