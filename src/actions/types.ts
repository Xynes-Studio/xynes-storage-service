/**
 * Action types — discriminated actor union mirrors PFU-1 / CMS-API-KEY-ACTOR-1.
 *
 * Raw API key material is NEVER carried in `ActionContext`. The gateway has
 * already verified the Argon2id hash and resolved the API key to its
 * `apiKeyId` + `keyPrefix` before forwarding. Storage-service must never
 * attempt to read `Authorization: Bearer xynes_live_...` directly.
 */
export type UserActor = {
  readonly kind: 'user';
  readonly userId: string;
};

export type ApiKeyActor = {
  readonly kind: 'api_key';
  readonly apiKeyId: string;
  readonly keyPrefix: string;
};

export type ActionActor = UserActor | ApiKeyActor;

export interface ActionContext {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly actor: ActionActor;
  /**
   * Legacy convenience field — populated only when `actor.kind === 'user'`.
   * Handlers should prefer `actor` for new code paths.
   */
  readonly userId?: string;
}

/**
 * Storage action keys (planned). Implementations land in STORAGE-5..STORAGE-7.
 */
export type StorageActionKey =
  | 'platform.storage.objects.upload'
  | 'platform.storage.objects.read'
  | 'platform.storage.objects.delete'
  | 'platform.storage.objects.process.retry'
  | 'platform.storage.usage.read'
  | 'platform.storage.providers.manage';

export type StorageActionHandler = (
  payload: unknown,
  ctx: ActionContext,
) => Promise<unknown> | unknown;
