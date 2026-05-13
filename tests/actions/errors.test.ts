import { describe, expect, test } from 'bun:test';
import {
  ForbiddenActorKindError,
  ForbiddenError,
  UnauthorizedError,
  UnknownActionError,
  ValidationError,
} from '../../src/actions/errors';

describe('action errors', () => {
  test('UnknownActionError carries code + statusHint + helpful message', () => {
    const e = new UnknownActionError('platform.storage.fake');
    expect(e.code).toBe('UNKNOWN_ACTION');
    expect(e.statusHint).toBe(400);
    expect(e.message).toContain('platform.storage.fake');
    expect(e.name).toBe('UnknownActionError');
  });

  test('ValidationError carries code + statusHint', () => {
    const e = new ValidationError('bad payload');
    expect(e.code).toBe('VALIDATION_ERROR');
    expect(e.statusHint).toBe(400);
    expect(e.message).toBe('bad payload');
  });

  test('UnauthorizedError defaults to a safe message', () => {
    const e = new UnauthorizedError();
    expect(e.code).toBe('UNAUTHORIZED');
    expect(e.statusHint).toBe(401);
    expect(e.message).toBe('Authentication required');
  });

  test('ForbiddenError defaults to a safe message', () => {
    const e = new ForbiddenError();
    expect(e.code).toBe('FORBIDDEN');
    expect(e.statusHint).toBe(403);
  });

  test('ForbiddenActorKindError has code FORBIDDEN_ACTOR_KIND', () => {
    const e = new ForbiddenActorKindError();
    expect(e.code).toBe('FORBIDDEN_ACTOR_KIND');
    expect(e.statusHint).toBe(403);
  });

  test('errors carry their class name (toolable in logs)', () => {
    expect(new ValidationError('x').name).toBe('ValidationError');
    expect(new UnauthorizedError().name).toBe('UnauthorizedError');
    expect(new ForbiddenError().name).toBe('ForbiddenError');
    expect(new ForbiddenActorKindError().name).toBe('ForbiddenActorKindError');
  });
});
