## Summary
<!-- One-paragraph description of what this PR does and why. -->

## Linked work
- Plan / issue: <!-- link -->
- Related repos: <!-- link any PRs that depend on or are depended on by this one -->

## Quality gates
- [ ] `lint` passes locally
- [ ] `test` passes locally
- [ ] Coverage ≥ ADR-001 80% floor (or justified exception below)
- [ ] `typecheck` / `build` passes (where applicable)
- [ ] Docs updated (`README.md`, `DEVELOPER.md`, `AGENTS.md`, repo memory)
- [ ] Migration added (if schema change) — forward-only, expand/contract
- [ ] QA PII scrub updated (if migration adds PII)
- [ ] Release doc set updated (if release contract changed)

## Security
- [ ] No secrets in code, logs, error messages, or test fixtures
- [ ] No raw API keys forwarded to downstream services
- [ ] No PII added to telemetry or access logs

## Deployment notes
<!-- e.g. "Requires migration run before service rollout", "Requires xynes-platform-contracts vX.Y.Z first". -->

## Rollback plan
<!-- For risky changes only. -->

---

## Repo-specific items (xynes-storage-service)

This is a **Bun + Hono + Drizzle** service that runs the universal object storage API on port `4204`. Use `bun`, never `npm`.

- [ ] Lint: `bun run lint` (eslint over `src/**/*.ts` + `tests/**/*.ts`)
- [ ] Tests: `bun test` (full suite; default env file `.env.dev` via `scripts/run-with-env.ts`)
- [ ] Coverage: `bun run test:coverage` — runs `scripts/test-coverage-gate.ts` which enforces the **ADR-001 80% lines + branches floor** at gate time (the gate exits non-zero below threshold). Current overall baseline is ~97% funcs / ~99% lines per the STORAGE-FU-* verification blocks; any regression below that level needs a justified exception below.
- [ ] Typecheck: `bun run typecheck` (= `tsc --noEmit`)
- [ ] **NO `drizzle-kit generate`, NO `drizzle-kit push` from this repo.** `src/infra/db/schema.ts` is a **READ-ONLY MIRROR** of the canonical Supabase schema owned by `xynes-infra/supabase/migrations/20260513090000_universal_storage_platform_schema.sql`. Schema changes MUST land in `xynes-infra` first, then this repo's mirror is updated in lockstep. `bun run db:check` (`scripts/db-check.ts`) is the drift-detection gate — it reads the canonical migration, asserts every closed-set type tuple matches the migration's CHECK constraints byte-for-byte, and asserts no forbidden raw-credential column ever appears. PRs that touch `src/infra/db/schema.ts` MUST run `bun run db:check` and confirm exit 0.
- [ ] **The `platform.storage_*` tables are co-owned with `xynes-infra`** (per `xynes-infra/docs/DATABASE.md` §3). DO NOT alter the schema from this repo; DO NOT touch `platform.*` non-storage tables, `identity.*`, `authz.*`, `cms.*`, `docs.*`, or `telemetry.*` — they are owned by their respective services.
- [ ] **Provider adapter contract (STORAGE-4 + STORAGE-9 §3 invariants).** Adapter changes in `src/infra/providers/` MUST preserve: always SigV4 (no `signatureVersion` override); NEVER emits `x-amz-tagging`; NEVER uses browser POST form uploads; presigned URLs signed against the S3 endpoint host only; presign expiry ∈ `[30s, 7d]`; SSE-KMS is NEVER set; SSE-C is the only customer-key path; provider errors wrapped in redacted `ProviderAdapterError` via `runWithRedactedError` (raw provider error messages, access keys, secret keys, `X-Amz-Signature` values NEVER propagate). Adding a new provider kind requires updating BOTH the canonical Supabase migration's CHECK constraint AND `STORAGE_PROVIDER_KINDS` in the Drizzle mirror — `bun run db:check` will fail if they drift.
- [ ] **`credential_ref` is the ONLY commit-safe credential surface.** No raw `accessKeyId` / `secretAccessKey` / `r2Token` / `xynes_live_*` / `AKIA*` / `re_*` substrings in any `.env*` file, test fixture, plan doc, PR description, or commit message. `EnvSecretManagerClient` (STORAGE-FU-3) reads from `STORAGE_CREDENTIAL_<PREFIX>_ACCESS_KEY_ID` + `STORAGE_CREDENTIAL_<PREFIX>_SECRET_ACCESS_KEY` in `.env.dev.local` (git-ignored). Hosted environments wire AWS Secrets Manager / Doppler / Vault implementations of the same interface.
- [ ] **Closed-set runner error codes only** (STORAGE-8). Sharp / ffmpeg / LibreOffice / clamav error text NEVER reaches the caller — only `PROFILE_GUARD_REJECTED` / `OVER_MAX_BYTES` / `OVER_MAX_DIMENSIONS` / `OVER_MAX_DURATION` / `UNSUPPORTED_FORMAT` / `MALWARE_DETECTED` / `SCANNER_INCONCLUSIVE` / `PROCESSOR_FAILED` propagate. `SCANNER_INCONCLUSIVE` is NEVER coerced to `clean` — that defeats STORAGE-9 §3.6.
- [ ] **Actor surface (PFU-1 + CMS-API-KEY-ACTOR-1 parity).** Internal route parses `X-XS-Actor-Type` / `X-XS-User-Id` / `X-XS-API-Key-Id` / `X-XS-API-Key-Prefix` per `ActionContext.actor` discriminated union (`UserActor | ApiKeyActor`). `requireUserActor(ctx)` and `getOptionalUserId(ctx)` guards in `src/actions/guards.ts` enforce the in-preset / out-of-preset write distinction. Audit columns (`created_by` / `updated_by`) are nullable so api_key actors leave them `NULL`.
- [ ] **Dedup is workspace-scoped only** (DEDUP-1 + DEDUP-2). The partial unique index keys on `(workspace_id, sha256)` — cross-workspace dedup is structurally impossible. `platform.storage_object_references` enforces reference-counted soft-delete.
- [ ] If adding a new gateway-reachable action: open the matching `xynes-infra/supabase/migrations/20251229100001_seed_platform_routes.sql` route seed PR (action endpoint must be `/internal/storage-actions`) AND the `xynes-authz-service` permission catalog PR in lockstep. Merge order: contracts/authz first, then this PR. Action keys MUST follow the `platform.storage.<domain>.<verb>` pattern.
- [ ] **Sidecars (`sidecars/libreoffice/`) have their own quality gates** (STORAGE-FU-5-FU-G). When touching the LibreOffice shim, run its own `bun --cwd sidecars/libreoffice run lint && bun --cwd sidecars/libreoffice run typecheck && bun --cwd sidecars/libreoffice run test`. Do NOT pin a floating tag (`:stable` / `:latest`); pin a specific patch version. ClamAV and LibreOffice container images in `xynes-infra/infra/compose/storage-live-processors.yml` follow the same pin-only rule.
- [ ] Live processor binaries (`STORAGE_PROCESSOR_MODE=live`) require sharp + ffmpeg-static in the storage-service Docker image AND the LibreOffice + clamav sidecars in the Compose overlay. See `docs/deployment-posture.md` §9.0 for the operator rollout checklist (drop `xynes-infra_storage-node_modules` named volume + rebuild before flipping the env var).
