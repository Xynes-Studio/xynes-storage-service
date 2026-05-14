/**
 * STORAGE-6 — workspace usage read.
 *
 * Action key: `platform.storage.usage.read` (with `operation: 'usage'`).
 *
 * Flow:
 *   1. Validate payload (strict schema; date inputs are YYYY-MM-DD only).
 *   2. Default to a 30-day window ending today (UTC).
 *   3. Refuse ranges longer than `MAX_USAGE_RANGE_DAYS` so a hostile caller
 *      cannot ask for years of daily data.
 *   4. Read pre-aggregated daily rows from the repo. The repo MUST NOT
 *      scan `storage_objects` for live totals — the daily aggregation job
 *      is the single producer of these rows (plan §STORAGE-6).
 *   5. Collapse per-provider rows into per-date entries (response builders
 *      strip `providerKind` — no per-provider field appears on the wire).
 *
 * Plan §STORAGE-3 deliberately defers the route seed for `platform.storage.usage.read`;
 * we wire the handler anyway because (a) it's stable contract-wise and
 * (b) once the route is enabled it's a single SQL `INSERT INTO platform.routes`
 * rather than a code change. Until then `executeStorageAction` will return
 * `UNKNOWN_ACTION` (400) for any client that somehow reaches the
 * storage-service with the key, which is the documented fail-closed posture.
 */
import { ValidationError } from '../../errors';
import type { ActionContext } from '../../types';
import { toUsageReadResponse, type UsageReadResponse } from './responses';
import { MAX_USAGE_RANGE_DAYS, usageReadPayloadSchema } from './schemas';
import type { ObjectsHandlerDependencies } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RANGE_DAYS = 30;

function toUtcDateString(d: Date): string {
  // YYYY-MM-DD using UTC parts. Avoids timezone drift between server +
  // client locales.
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function parseUtcDate(s: string): Date {
  // Parse strict YYYY-MM-DD at UTC midnight. The schema already enforces
  // shape, so failures here are programmer error.
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function dayDiff(fromIso: string, toIso: string): number {
  const f = parseUtcDate(fromIso).getTime();
  const t = parseUtcDate(toIso).getTime();
  return Math.floor((t - f) / DAY_MS) + 1;
}

export function createUsageReadHandler(deps: ObjectsHandlerDependencies) {
  const now = deps.now ?? (() => new Date());

  return async (payload: unknown, ctx: ActionContext): Promise<UsageReadResponse> => {
    const parseResult = usageReadPayloadSchema.safeParse(payload);
    if (!parseResult.success) {
      throw new ValidationError(parseResult.error.issues[0]?.message ?? 'Invalid payload');
    }
    const input = parseResult.data;

    const today = toUtcDateString(now());
    const todayDate = parseUtcDate(today);
    const defaultFrom = toUtcDateString(
      new Date(todayDate.getTime() - (DEFAULT_RANGE_DAYS - 1) * DAY_MS),
    );

    const from = input.from ?? defaultFrom;
    const to = input.to ?? today;

    if (from > to) {
      throw new ValidationError('`from` must be on or before `to`');
    }
    const span = dayDiff(from, to);
    if (span > MAX_USAGE_RANGE_DAYS) {
      throw new ValidationError(`Usage range exceeds the ${MAX_USAGE_RANGE_DAYS}-day maximum`);
    }

    const rows = await deps.usage.readDailyForWorkspace({
      workspaceId: ctx.workspaceId,
      fromDate: from,
      toDate: to,
    });

    return toUsageReadResponse(rows, from, to);
  };
}
