# Architecture (local mirror)

> This file is a **local mirror** of the architecture summary in
> `xynes-infra/infra/architecture/epics/universal-object-storage.md`.
> The infra epic is the source of truth. When the two diverge, fix the infra
> epic first, then re-sync this file.

## Service boundary

`xynes-storage-service` is a new platform-level backend service.

- **Database ownership:** `platform.*` tables (managed by `xynes-infra`
  Supabase migrations; STORAGE-2 introduces the storage tables).
- **Gateway exposure:** dynamic `platform.routes` rows with
  `service_key = 'storage-service'` (STORAGE-3).
- **Authz:** action-key permissions in `xynes-authz-service` catalog
  (STORAGE-3).
- **First frontend consumer:** CMS Console storage client (STORAGE-10)
  followed by editor upload UX (STORAGE-11).

## High-level flow

```
┌─────────┐    1. create upload session      ┌─────────┐
│ Browser │ ───────────────────────────────▶ │ Gateway │
└─────────┘                                   └────┬────┘
     ▲                                            │ 2. authn + scope check
     │                                            │    forward actor headers
     │                                            ▼
     │                                  ┌──────────────────┐
     │                                  │ Storage-service  │
     │                                  └────────┬─────────┘
     │                                           │ 3. create object + session rows
     │                                           │ 4. sign provider URL(s)
     │           5. signed URL + metadata        │
     │ ◀─────────────────────────────────────────┘
     │
     │ 6. direct upload (PUT or multipart)
     │
     │            ┌─────────────────┐
     └──────────▶ │ Object storage  │  (Cloudflare R2 / MinIO / S3-compatible)
                  └─────────────────┘
                          │
     ┌─────────┐  7. complete   ┌──────────────────┐
     │ Browser │ ──────────────▶│ Storage-service  │
     └─────────┘                └────────┬─────────┘
                                         │ 8. queue async processing jobs
                                         │    (scan / variants / poster / transcode)
                                         ▼
                                  ┌─────────────┐
                                  │   Workers   │  STORAGE-7 / STORAGE-8
                                  └─────────────┘
```

CMS content bodies persist `objectId` references **only**. Provider URLs are
fetched on demand via `POST /storage/objects/:objectId/download-url`.

## Action-key surface (planned)

| Action key                                  | Story     |
| ------------------------------------------- | --------- |
| `platform.storage.objects.upload`           | STORAGE-5 |
| `platform.storage.objects.read`             | STORAGE-6 |
| `platform.storage.objects.delete`           | STORAGE-6 |
| `platform.storage.objects.process.retry`    | STORAGE-7 |
| `platform.storage.usage.read`               | STORAGE-6 |
| `platform.storage.providers.manage`         | Workspace Admin (later) |

Source plan §7–§8 carries the authoritative table.

## Defense-in-depth posture

1. **Gateway scope check** — route `actionKey` is enforced against the
   workspace API key's scopes before reaching storage-service. Layering
   matches CMS-API-KEY-ACTOR-1.
2. **Storage-service workspace check** — every action handler asserts that
   the requested object/session row belongs to `ctx.workspaceId`.
3. **Per-handler audit policy** — in-preset writes leave `created_by` NULL
   for `api_key` actors; out-of-preset writes gate with
   `requireUserActor(ctx)` and return `403 FORBIDDEN_ACTOR_KIND`.
4. **No app-local role logic** — role-to-action mapping lives entirely in
   `xynes-authz-service`.

## MVP scope vs deferred

| Item                                                       | MVP scope    |
| ---------------------------------------------------------- | ------------ |
| Cloudflare R2 (Standard) adapter — default hosted provider | **In**       |
| MinIO / S3-compatible config support via the same adapter class | **In** (opt-in ad-hoc; not auto-provisioned) |
| Backblaze B2, iDrive e2 — config-only via same adapter | **In** (config-compatible; live wiring deferred) |
| Tigris, AWS S3, Supabase, customer (BYOS) buckets          | Deferred     |
| Direct browser-to-provider uploads                         | **In**       |
| Async post-upload processing (scan, image variants, video poster) | **In** |
| `cms_media` purpose for CMS authoring                      | **In**       |
| In-app provider configuration UI                           | Deferred (Workspace Admin) |
| CDN invalidation UI                                        | Deferred     |
| OCR / AI moderation / DLP                                  | Deferred     |

## Forbidden in production

| Forbidden thing                                         | Why |
| -------------------------------------------------------- | --- |
| Raw provider credentials stored in `platform.*` tables  | Always store **references** (secret manager entry, env alias). |
| Provider URLs persisted in CMS entry bodies             | Bodies store `objectId` references only. |
| Signed URLs in service logs                             | Single-use; logging the URL extends its blast radius. |
| Raw `xynes_live_*` API keys in any log line             | Already redacted by gateway Task 6; storage-service must not undo that. |

## References

- Source plan: `xynes-infra/docs/plans/2026-05-10-universal-object-storage-file-upload-api.md`
- Provider env-values worksheet: `xynes-infra/docs/plans/2026-05-13-storage-provider-env-values-worksheet.md`
- Epic: `xynes-infra/infra/architecture/epics/universal-object-storage.md`
- Sibling epic for posture parity:
  `xynes-infra/infra/architecture/epics/workspace-admin-integrations.md`
