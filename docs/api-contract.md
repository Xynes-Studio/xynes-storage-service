# API Contract (planned)

> **Status:** All routes and payload shapes in this document are **planned**.
> The runtime route handlers, request/response schemas (Zod), and contract
> tests land in **STORAGE-5** (uploads), **STORAGE-6** (objects + usage), and
> **STORAGE-7** (processing retry). This file is the read-once reference
> those stories will implement against.
>
> The source plan
> (`xynes-infra/docs/plans/2026-05-10-universal-object-storage-file-upload-api.md`
> §7–§7.1) is the authoritative source. This file mirrors it so a contributor
> working in this repo does not need to cross-reference `xynes-infra` first.

## Route table

All routes go through `xynes-gateway` dynamic routing.

| Method | Path                                                          | Action key                            | Story     |
| ------ | ------------------------------------------------------------- | ------------------------------------- | --------- |
| `POST` | `/workspaces/:workspaceId/storage/uploads`                    | `platform.storage.objects.upload`     | STORAGE-5 |
| `POST` | `/workspaces/:workspaceId/storage/uploads/:uploadId/complete` | `platform.storage.objects.upload`     | STORAGE-5 |
| `POST` | `/workspaces/:workspaceId/storage/uploads/:uploadId/abort`    | `platform.storage.objects.upload`     | STORAGE-5 |
| `GET`  | `/workspaces/:workspaceId/storage/objects`                    | `platform.storage.objects.read`       | STORAGE-6 |
| `GET`  | `/workspaces/:workspaceId/storage/objects/:objectId`          | `platform.storage.objects.read`       | STORAGE-6 |
| `POST` | `/workspaces/:workspaceId/storage/objects/:objectId/download-url` | `platform.storage.objects.read`   | STORAGE-6 |
| `DELETE` | `/workspaces/:workspaceId/storage/objects/:objectId`        | `platform.storage.objects.delete`     | STORAGE-6 |
| `POST` | `/workspaces/:workspaceId/storage/objects/:objectId/process/retry` | `platform.storage.objects.process.retry` | STORAGE-7 |

All routes are workspace-scoped (`workspace_scoped = true` in
`platform.routes`) and **not public** (`is_public = false`). The gateway
forwards each call to storage-service's `POST /internal/storage-actions` internal
endpoint with the matched `actionKey` and the resolved actor headers.

## Create upload session

**Route:** `POST /workspaces/:workspaceId/storage/uploads`
**Action key:** `platform.storage.objects.upload`

### Request body

| Field         | Required | Type    | Notes                                                                         |
| ------------- | -------- | ------- | ----------------------------------------------------------------------------- |
| `filename`    | yes      | string  | Original filename for display and object-key derivation.                      |
| `contentType` | yes      | string  | Claimed MIME type. Processing must later verify detected type.                |
| `byteSize`    | yes      | integer | Used for size limits and single-vs-multipart selection.                       |
| `sha256`      | no       | string  | Optional client-side checksum (hex, 64 chars).                                |
| `purpose`     | no       | string  | Defaults to generic platform purpose. CMS clients pass `cms_media`.           |
| `visibility`  | no       | string  | Defaults to `private`. `public` only takes effect after scan/validation.      |
| `compression` | no       | boolean | Defaults to `true`. Drives image/video processing job creation.               |

### Response body

| Field            | Type    | Notes                                                                |
| ---------------- | ------- | -------------------------------------------------------------------- |
| `uploadId`       | string  | Upload session ID.                                                   |
| `objectId`       | string  | Stable Xynes storage object ID. **Store this in app data**, never the upload URL. |
| `uploadMethod`   | string  | `single` or `multipart` based on `byteSize` vs threshold (default 100 MB). |
| `uploadUrl`      | string  | Present for `single` uploads. **Single-use, short expiry. Never log.** |
| `uploadHeaders`  | object  | Headers the browser must send to the provider for `single` upload.   |
| `parts`          | array   | Present for `multipart` uploads. Each entry: `{ partNumber, signedUrl, headers? }`. |
| `expiresAt`      | string  | RFC 3339 timestamp. Upload URL / session expiry.                     |
| `object`         | object  | Initial object metadata with `status = "pending_upload"`.            |

## Complete upload session

**Route:** `POST /workspaces/:workspaceId/storage/uploads/:uploadId/complete`
**Action key:** `platform.storage.objects.upload`

### Request body

| Field    | Required        | Type   | Notes                                                          |
| -------- | --------------- | ------ | -------------------------------------------------------------- |
| `sha256` | no              | string | Optional final checksum if not supplied at create time.        |
| `parts`  | multipart only  | array  | `{ partNumber, etag, checksum? }` values returned by provider. |

### Response body

| Field             | Type    | Notes                                                                                  |
| ----------------- | ------- | -------------------------------------------------------------------------------------- |
| `object`          | object  | Object metadata. Typically `status = "processing"` immediately after completion.       |
| `processingJobs`  | array   | Queued validation/scan/compression/preview/transcode jobs with their initial statuses. |

## Abort upload session

**Route:** `POST /workspaces/:workspaceId/storage/uploads/:uploadId/abort`
**Action key:** `platform.storage.objects.upload`

Aborts the provider-side multipart upload (where applicable) and marks the
session `aborted`. Provider abort errors are **safely reported and never
include credentials.** Idempotent against already-aborted sessions.

## List storage objects

**Route:** `GET /workspaces/:workspaceId/storage/objects`
**Action key:** `platform.storage.objects.read`

### Query params (planned)

| Param           | Notes                                                                  |
| --------------- | ---------------------------------------------------------------------- |
| `purpose`       | Filter by purpose (e.g., `cms_media`).                                 |
| `status`        | Filter by object status (`pending_upload`, `uploaded`, `processing`, `ready`, `failed`, `deleted`). |
| `contentType`   | Filter by content-type family (`image/`, `video/`, `application/pdf`, …). |
| `createdAfter`  | RFC 3339 timestamp.                                                    |
| `createdBefore` | RFC 3339 timestamp.                                                    |
| `cursor`        | Pagination cursor.                                                     |
| `limit`         | Page size, default 50, max 200.                                        |

## Get storage object

**Route:** `GET /workspaces/:workspaceId/storage/objects/:objectId`
**Action key:** `platform.storage.objects.read`

Returns one object's metadata + its `variants` array + its `processingJobs`
state. Returns `404 NOT_FOUND` if the object is `deleted` or belongs to a
different workspace.

## Create download URL

**Route:** `POST /workspaces/:workspaceId/storage/objects/:objectId/download-url`
**Action key:** `platform.storage.objects.read`

Returns `{ objectId, url, expiresAt }`. **Short-lived signed read URL.** The
service refuses to mint a URL for `pending_upload` / `processing` / `failed`
/ `deleted` objects.

## Delete storage object

**Route:** `DELETE /workspaces/:workspaceId/storage/objects/:objectId`
**Action key:** `platform.storage.objects.delete`

Soft-deletes metadata (sets `status = "deleted"`) and deletes or
lifecycle-marks the provider object per workspace policy. Subsequent
download-url requests for the same `objectId` return `409 OBJECT_DELETED`.

## Retry processing

**Route:** `POST /workspaces/:workspaceId/storage/objects/:objectId/process/retry`
**Action key:** `platform.storage.objects.process.retry`

Requeues failed processing jobs. Only available for objects whose required
jobs entered `failed` state after retries. No-op for `ready` objects;
returns `409 NOT_RETRYABLE` for `pending_upload` / `processing`.

## Usage read

**Route:** Surface TBD in STORAGE-6 (likely `GET /workspaces/:workspaceId/storage/usage`).
**Action key:** `platform.storage.usage.read`

Reads aggregated daily usage from `platform.storage_usage_daily`. **Never
scans `platform.storage_objects` for expensive live totals during normal
requests.**

## Status models

### Object status

`pending_upload` → `uploaded` → `processing` → `ready` | `failed` | `deleted`

### Upload session status

`pending` → `completed` | `aborted` | `expired`

### Processing job status

`queued` → `running` → `succeeded` | `failed` | `cancelled`

## Error envelope

All errors return the canonical envelope:

```json
{
  "ok": false,
  "error": {
    "code": "MACHINE_READABLE_CODE",
    "message": "Human-readable summary",
    "details": { /* optional */ }
  },
  "meta": { "requestId": "..." }
}
```

Known error codes (subset; full list in STORAGE-5/6 schemas):

| Code                       | HTTP | Notes                                                          |
| -------------------------- | ---- | -------------------------------------------------------------- |
| `VALIDATION_FAILED`        | 400  | Zod parse error on payload.                                    |
| `INVALID_HEADER`           | 400  | Malformed `X-XS-Actor-Type` / `X-XS-API-Key-Id` / etc.         |
| `MISSING_HEADER`           | 400  | Required header absent (e.g., `X-Workspace-Id`).               |
| `UNAUTHORIZED`             | 401  | Missing or invalid actor.                                      |
| `FORBIDDEN`                | 403  | Workspace mismatch or scope miss (gateway is upstream owner).  |
| `FORBIDDEN_ACTOR_KIND`     | 403  | `api_key` actor on an action that requires a human user.       |
| `NOT_FOUND`                | 404  | Object or upload session not found in workspace.               |
| `UNKNOWN_ACTION`           | 404  | Unknown `actionKey` value.                                     |
| `OBJECT_DELETED`           | 409  | Action attempted on a soft-deleted object.                     |
| `NOT_RETRYABLE`            | 409  | Retry on non-retryable state.                                  |
| `UPLOAD_EXPIRED`           | 409  | `complete` on an expired upload session.                       |
| `PAYLOAD_TOO_LARGE`        | 413  | Byte-size exceeds workspace policy.                            |
| `INTERNAL_ERROR`           | 500  | Catch-all; never leaks credentials or signed URLs.             |

## Notes

- Provider abort errors are translated into safe, redacted envelopes.
- Idempotency: `complete` and `abort` are idempotent against terminal
  states. Other actions return `409` state-conflict envelopes where
  appropriate.
- Raw API keys (`xynes_live_*`) never appear in any request handled by
  storage-service — the gateway has already resolved them.
