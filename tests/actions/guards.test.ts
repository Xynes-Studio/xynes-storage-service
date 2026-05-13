/**
 * Action guards — `isApiKeyActor`, `getOptionalUserId`, `requireUserActor`.
 *
 * Mirror tests of the PFU-1 / CMS-API-KEY-ACTOR-1 actor guard surface.
 */
import { describe, expect, test } from 'bun:test';
import { getOptionalUserId, isApiKeyActor, requireUserActor } from '../../src/actions/guards';
import { ForbiddenActorKindError } from '../../src/actions/errors';
import type { ActionContext } from '../../src/actions/types';

function makeUserCtx(userId = '00000000-0000-4000-8000-000000000000'): ActionContext {
  return {
    workspaceId: '00000000-0000-4000-8000-00000000ffff',
    requestId: 'req-1',
    actor: { kind: 'user', userId },
    userId,
  };
}

function makeApiKeyCtx(): ActionContext {
  return {
    workspaceId: '00000000-0000-4000-8000-00000000ffff',
    requestId: 'req-2',
    actor: { kind: 'api_key', apiKeyId: 'k-1', keyPrefix: 'abcd1234' },
  };
}

describe('isApiKeyActor', () => {
  test('true for api_key actor', () => {
    expect(isApiKeyActor(makeApiKeyCtx())).toBe(true);
  });
  test('false for user actor', () => {
    expect(isApiKeyActor(makeUserCtx())).toBe(false);
  });
});

describe('getOptionalUserId', () => {
  test('returns userId for user actor', () => {
    expect(getOptionalUserId(makeUserCtx('u-1'))).toBe('u-1');
  });
  test('returns null for api_key actor', () => {
    expect(getOptionalUserId(makeApiKeyCtx())).toBeNull();
  });
});

describe('requireUserActor', () => {
  test('returns userId for user actor', () => {
    expect(requireUserActor(makeUserCtx('u-2'))).toBe('u-2');
  });
  test('throws ForbiddenActorKindError for api_key actor', () => {
    try {
      requireUserActor(makeApiKeyCtx());
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenActorKindError);
      expect((err as ForbiddenActorKindError).code).toBe('FORBIDDEN_ACTOR_KIND');
      expect((err as ForbiddenActorKindError).statusHint).toBe(403);
    }
  });
});
