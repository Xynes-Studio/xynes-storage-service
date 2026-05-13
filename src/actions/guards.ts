/**
 * Action context guards (PFU-1 / CMS-API-KEY-ACTOR-1 byte-for-byte parity).
 *
 * `requireUserActor` / `getOptionalUserId` / `isApiKeyActor` are documented
 * here so STORAGE-5..STORAGE-7 handlers can adopt the audit policy without
 * inventing a new contract.
 */
import { ForbiddenActorKindError } from './errors';
import type { ActionContext } from './types';

export function isApiKeyActor(ctx: ActionContext): boolean {
  return ctx.actor.kind === 'api_key';
}

/**
 * Returns the user id when the actor is a human user, otherwise `null`.
 *
 * Use this in in-preset write handlers so audit columns can be left NULL
 * for `api_key` actors (`cms.content_entries.created_by` / `updated_by` is
 * the canonical reference pattern).
 */
export function getOptionalUserId(ctx: ActionContext): string | null {
  if (ctx.actor.kind === 'user') return ctx.actor.userId;
  return null;
}

/**
 * Hard-gate a handler to user actors only. Throws `ForbiddenActorKindError`
 * (mapped to `403 FORBIDDEN_ACTOR_KIND` by the error handler) for `api_key`
 * actors.
 *
 * Use this in out-of-preset write handlers as defense-in-depth: the gateway
 * already 403s these for the MVP presets, but a future preset change could
 * leak the action key through — the handler-level check is a second line.
 */
export function requireUserActor(ctx: ActionContext): string {
  if (ctx.actor.kind !== 'user') {
    throw new ForbiddenActorKindError();
  }
  return ctx.actor.userId;
}
