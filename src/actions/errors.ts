/**
 * Action-layer error families.
 *
 * Mirrors `xynes-accounts-service/src/actions/errors.ts` + the
 * `ForbiddenActorKindError` extension introduced by CMS-API-KEY-ACTOR-1 Story C.
 */

export class UnknownActionError extends Error {
  public readonly code = 'UNKNOWN_ACTION';
  public readonly statusHint = 400 as const;

  constructor(actionKey: string) {
    super(`Unknown action: ${actionKey}`);
    this.name = 'UnknownActionError';
  }
}

export class ValidationError extends Error {
  public readonly code = 'VALIDATION_ERROR';
  public readonly statusHint = 400 as const;

  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class UnauthorizedError extends Error {
  public readonly code = 'UNAUTHORIZED';
  public readonly statusHint = 401 as const;

  constructor(message = 'Authentication required') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends Error {
  public readonly code = 'FORBIDDEN';
  public readonly statusHint = 403 as const;

  constructor(message = 'Forbidden') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export class ForbiddenActorKindError extends Error {
  public readonly code = 'FORBIDDEN_ACTOR_KIND';
  public readonly statusHint = 403 as const;

  constructor(message = 'This action requires a user actor') {
    super(message);
    this.name = 'ForbiddenActorKindError';
  }
}
