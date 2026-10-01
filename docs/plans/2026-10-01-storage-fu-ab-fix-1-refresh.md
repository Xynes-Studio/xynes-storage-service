# STORAGE-FU-AB-FIX-1 PR #29 Refresh Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Update PR #29 against current develop while retaining SEC-001/002 protections.

**Architecture:** Keep production-dependencies and the minimal non-root prod image.
Probe installed Sharp and executable ffmpeg in dev and in the copied prod runtime.
Refresh only the storage dependency volume in the documented local procedure.

**Tech Stack:** Bun 1.2.18, Docker, existing infra shell contract, Bun coverage gate.

### Task 1: Merge current develop

- Merge develop into the existing PR branch in an isolated worktree.
- Resolve Dockerfile using develop's stages, native decoder gate and non-root CMD.
- Preserve source/provider scan gates and archive supervisor without edits.

### Task 2: Restore binary checks

- Run existing `xynes-infra/scripts/test/storage-fu-ab-fix-1-live-processor-binaries.test.sh`
  using a disposable sibling layout pointing at this checkout; observe missing probes.
- Add to dev and final prod stages:
  `RUN bun -e 'require("sharp"); const p = require("ffmpeg-static"); require("fs").accessSync(p, require("fs").constants.X_OK); if (Bun.spawnSync([p, "-version"]).exitCode !== 0) throw new Error("FFMPEG_UNAVAILABLE");'`
- Run the same contract and build both targets. Verify non-executable/missing
  ffmpeg is rejected with harmless disposable container overrides.

### Task 3: Correct operator documentation

- Modify DEVELOPER.md's story row and docs/deployment-posture.md §9.0.
- Use .env.dev; stop and remove only storage-service before removing its dependency
  volume. Resolve the actual volume name from the container instead of assuming a prefix.
- Keep hosted security deployment separate from dev dependency-volume maintenance.

### Task 4: Verify and publish the update

- Run full lint/typecheck and configured >=80% coverage; run existing image-security
  verification and real ffmpeg fixture tests inside the production image.
- Review the final diff against develop, commit and push to the existing PR branch.
- Update PR description and report current checks; do not merge or deploy.

### Validation record

Validated 2026-10-01 against develop `b247c8a` in an isolated checkout.

- Existing infra binary contract: red before adding probes, green afterwards.
- Both Linux amd64 Docker targets build with the executable-startup probe.
  Positive checks pass; harmless missing-module and mode-0644 binary overrides
  fail in both images. Bun's `X_OK` check alone accepted the latter fixture,
  so the guard also executes `ffmpeg -version` and checks its exit code.
- Disposable dependency-volume fixture reproduced the stopped-container
  reference, removed only its owned container/volume, and verified that a
  recreated volume restores working processor binaries.
- `bun run test:coverage`: 1710 pass, 18 environment-gated skips, 0 failures;
  function coverage 93.11%, line coverage 94.54% (configured 80% floor).
  No application TypeScript changed; coverage attribution is unchanged.
- `bun run lint`, `bun run typecheck`, static `bun run db:check`, and
  `git diff --check` pass. DB check used the canonical infra migration;
  no database changes or deployment performed.
- Production image: Compose isolation/native runtime checks and 93 native
  image/scan/download tests pass with read-only, non-root, no-network,
  capability-dropped execution. Provider/mapper cohort: 107 pass. Real
  ffmpeg MP4 probe/poster/transcode/metadata fixtures: 6 pass.
- Local amd64 emulation timed out immutable-source tests at the wrapper's
  default 5-second timeout. Sequential rerun of those 6 tests passes with
  `bun test --timeout 30000`, preserving image/container hardening. The
  unmodified release wrapper's default-timeout result remains a local
  validation limitation; native Linux CI runs the configured default gate.
- Primary checkout's unrelated health work remains untouched. Final PR
  scope is Dockerfile, deployment docs, the story row, and this record.
