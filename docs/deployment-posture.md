# Deployment Posture — Live processors (STORAGE-FU-5-FU-E)

> **Status:** Decision landed 2026-05-28.
> **Scope:** Per-processor posture for the four live processors STORAGE-FU-5-FU-A..D needs in `STORAGE_PROCESSOR_MODE=live`.
> **Predecessor:** [STORAGE-FU-5 / FU-A](./architecture.md) — runner DI contracts + Sharp-backed `ImageProcessor`.
> **Closes:** STORAGE-FU-5-FU-E in `xynes/xynes-infra/docs/plans/2026-05-27-storage-followups-combined.md` §6.

This document is the single architectural record of **how each live processor is deployed**. It does NOT install any binary or wire any new code path — the per-processor implementation stories (FU-A..D) consume this decision via the env contract documented in §4.

---

## 1. Decision summary

| Processor   | Posture                  | Image footprint              | Rationale |
|-------------|--------------------------|------------------------------|-----------|
| sharp       | **In-process (Dockerfile)** | ~30 MB (libvips + binding)  | Pure Node binding; in-memory byte I/O; tight library coupling; no daemon. |
| ffmpeg      | **In-process (Dockerfile)** | ~80 MB (`ffmpeg-static`)    | Static binary; piped stdin/stdout I/O; no daemon; no shared state across invocations. |
| LibreOffice | **Sidecar container**    | ~400 MB (soffice + JRE + fonts) | 4× the storage-service image size; cold-start cost; restart-on-OOM; isolation from the request hot path. |
| clamav      | **Sidecar container**    | ~250 MB (clamd + virus defs) | Virus-definition refresh restart cadence is independent of the storage-service deploy cadence; `freshclam` runs in a second sidecar so a definition-fetch outage cannot take down scanning; least-privilege isolation. |

**Tier-1 (in-process):** sharp + ffmpeg. Bundled directly into the storage-service Docker image by FU-A (sharp, landed 2026-05-28) and FU-B (ffmpeg, future).

**Tier-2 (sidecars):** LibreOffice + clamav. Reached over the pod-local network only.

### Why this split

The MVP target is a single VPS with Docker Compose (per `xynes/xynes-infra/infra/release/RELEASE-STRATEGY.md` §3.2) and a future migration path to single-node K3s (per `xynes/xynes-infra/infra/release/K8S-READINESS-CHECKLIST.md` §6). The split keeps the **runtime hot path** small and fast (sharp + ffmpeg in the same address space as the worker → low per-job latency, no extra hop) while pushing the **fat dependencies with independent lifecycles** into sidecars (LibreOffice's JRE + fonts; clamav's nightly definition refresh).

### What this is NOT

- **Not a third option ("remote service over the public internet").** Both sidecars share the pod / compose network; no live processor reaches the public internet. (`freshclam` is the one exception — see §6.)
- **Not a per-processor language rewrite.** All four processors stay TypeScript-callable through the STORAGE-8 ports — the sidecar processors just speak a thin protocol (`soffice --convert-to` over a per-request HTTP shim for LibreOffice, `INSTREAM` over TCP/socket for clamav).
- **Not pre-mature K8s.** This document specifies Compose service definitions today and draft K3s manifests for §6 of the K8s readiness checklist. No K8s artefacts are deployed by MVP rollout.

---

## 2. Tier-1: in-process processors

### Sharp (FU-A — already landed)

Bundled via `sharp@^0.34.5` in the storage-service `package.json`. The OCI `oven/bun:1` base image ships glibc; sharp's npm package includes a pre-built libvips for linux-x64-glibc. No Dockerfile change was needed for FU-A.

- **Constructor cost:** ~50 ms first call (lazy-loaded per PR #15 Codex P1 fix); ~0 ms thereafter.
- **Memory:** sharp's pixel cache is **disabled** at module load via `sharp.cache(false)` — no cross-tenant pixel residue. Per-call working set is bounded by the image dimensions (≤ 16k × 16k via `MAX_IMAGE_DIMENSION` re-check).
- **CPU:** libvips is multi-threaded; no thread-pool tuning needed at MVP scale.
- **Failure mode:** corrupted libvips binding → `buildLiveImageProcessor()` falls back to `ProductionImageProcessorStub` with a single startup `WARN` (no per-call log spam). Image jobs dead-letter cleanly; the worker keeps running.

### ffmpeg (FU-B — future)

To be bundled via `ffmpeg-static` + `fluent-ffmpeg`. Per FU-B's acceptance criteria the OCI base image stays unchanged; ffmpeg ships as a static binary inside `node_modules/ffmpeg-static/`. Bun's `Bun.spawn` is the preferred invocation path (lower overhead than `child_process`).

- **Memory:** bounded by `MAX_VIDEO_DIMENSION` (4k) + `MAX_VIDEO_DURATION_SECONDS` (1h).
- **CPU:** transcoding is CPU-bound; the MVP worker concurrency cap (`STORAGE_WORKER_MAX_CONCURRENT=4`) is the throttle.
- **Failure mode:** missing binary → `WARN` + production-stub fallback (same posture as FU-A).
- **Timeout:** per-job timeout via `STORAGE_FFMPEG_TIMEOUT_MS` (default 5 minutes).

### Why these two stay in-process

| Property | sharp | ffmpeg |
|---|---|---|
| Binary footprint | ~30 MB | ~80 MB |
| Combined storage-service image (target) | ≤ 200 MB | ≤ 200 MB (combined) |
| Per-call overhead vs sidecar | ~0 (FFI / pipe) | ~10 ms (pipe vs network) |
| Independent restart needed? | No | No |
| Cross-tenant state | None (cache disabled) | None (no daemon) |
| Dockerfile complexity | Zero (npm dep) | Zero (npm dep) |

Both processors process bytes **in memory only** — no filesystem temp files reach disk. A crash mid-encode cannot leak partial bytes (STORAGE-9 invariant preserved).

---

## 3. Tier-2: sidecars

### Why sidecars for LibreOffice + clamav

| Property | LibreOffice | clamav |
|---|---|---|
| Binary footprint | ~400 MB (`soffice` + JRE + fonts) | ~250 MB (`clamd` + virus defs) |
| Independent restart cadence | No (deploy-time only) | **Yes** — nightly `freshclam` definition refresh |
| Per-invocation cost | High startup (~2 s per `soffice` cold start without sidecar daemon) | Low (`INSTREAM` socket reuse) |
| Failure-blast-radius if collocated | Storage-service pod OOM kills | Storage-service pod OOM kills |
| Failure-blast-radius if sidecar | Sidecar OOM → restart; document jobs degrade to dead-letter; image + video unaffected | Sidecar OOM → restart; scanner returns `unknown` (`SCANNER_INCONCLUSIVE`); jobs requeue |
| K8s least-privilege fit | Excellent (drop all capabilities; read-only root FS) | Excellent (drop all capabilities; read-only root FS) |

### LibreOffice sidecar — `libreoffice-sidecar`

A long-lived `soffice` process in headless mode behind a thin Bun HTTP shim that accepts `POST /convert { sourceContentType, bytes }` and returns the PNG/JPEG preview. Per-request `soffice` startup is avoided by keeping the JRE warm via LibreOffice's `--accept` socket protocol.

> **⚠️ Implementation status (FU-E vs FU-C).** FU-E (this story) commits to the **sidecar topology + env contract + security posture** only. The Bun HTTP shim that actually serves `POST /convert` + `GET /health` on TCP `8100` is **owned by FU-C** (`STORAGE-FU-5-FU-C — LibreOffice-backed DocumentProcessor`). The canonical Compose overlay at `xynes/xynes-infra/infra/compose/storage-live-processors.yml` pins the placeholder image `lscr.io/linuxserver/libreoffice:7.6.7` for dev/QA convenience, but that image ships a desktop GUI on ports 3000/3001 — it does NOT serve the `/convert` HTTP API documented in §4. The compose overlay's own inline comment calls this out and FU-C will replace the placeholder image with a custom slim image that runs `soffice --headless --accept` plus the Bun shim. Until FU-C lands, an operator who flips `STORAGE_PROCESSOR_MODE=live` will see `document_preview` jobs dead-letter via `PROCESSOR_FAILED` (the safe-fail behaviour documented in §4) — the document-preview leg of Bug 1 stays open until FU-C closes it.

- **macros disabled** via `SAL_DISABLE_MACROS=1` set on the sidecar container env (canonical compose overlay line 50; K8s deployment manifest line 41). This is LibreOffice's documented globally-enforced environment switch — `--disable-macros` is NOT a real CLI flag in the official parameter list (see [LibreOffice start parameters](https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html)). Macro RCE surface against malicious documents is closed at the container env level, not via a per-request CLI flag. STORAGE-9 §3.6 invariant.
- **temp directory cleanup** runs `finally` per request; the sidecar's own temp dir is `tmpfs`-mounted so a crash leaves no on-disk residue.
- **timeout** per request (default 60 s) via `STORAGE_SOFFICE_TIMEOUT_MS`.
- **discovery** — storage-service reaches the sidecar via `LIBREOFFICE_SERVICE_URL=http://libreoffice-sidecar:8100` (the shim's listen port, once FU-C lands).

### clamav sidecars — `clamav-clamd` + `clamav-freshclam`

Two sidecars because their lifecycles are independent:

1. **`clamav-clamd`** — long-lived `clamd` daemon listening on TCP `3310` (or Unix socket). Scanning uses the `INSTREAM` protocol (bytes streamed in over the socket; no temp file ever touches disk).
2. **`clamav-freshclam`** — long-lived `freshclam` updater that fetches definitions on a configurable schedule (default every 24 h). Writes to a **shared named volume** that `clamav-clamd` reads. A `freshclam` failure restarts ONLY the `freshclam` container; `clamd` keeps scanning against the last good definitions.
- **`unknown` is never coerced to `clean`** (STORAGE-9 §3.6 invariant). A clamd disconnect or read timeout surfaces as `SCANNER_INCONCLUSIVE` → STORAGE-7 worker retries with backoff and dead-letters at `maxAttempts`.
- **discovery** — storage-service reaches the clamd sidecar via `CLAMD_HOST=clamav-clamd` + `CLAMD_PORT=3310`.

---

## 4. Env contract (consumed by FU-A..D)

The processor implementations in FU-A..D read these env vars (set by the operator per deployment):

| Env var | Default | Tier | Notes |
|---|---|---|---|
| `STORAGE_PROCESSOR_MODE` | `stub` (non-prod) / `live` (prod) | — | Master switch. `stub` ignores the rest. |
| `STORAGE_FFMPEG_TIMEOUT_MS` | `300000` (5 min) | Tier-1 (ffmpeg) | Per-job timeout. |
| `STORAGE_SOFFICE_TIMEOUT_MS` | `60000` (60 s) | Tier-2 (LibreOffice) | Per-job timeout. |
| `LIBREOFFICE_SERVICE_URL` | `http://libreoffice-sidecar:8100` | Tier-2 (LibreOffice) | Sidecar HTTP endpoint. **Pod-local DNS only** — never a public URL. |
| `CLAMD_HOST` | `clamav-clamd` | Tier-2 (clamav) | Sidecar hostname. **Pod-local DNS only**. |
| `CLAMD_PORT` | `3310` | Tier-2 (clamav) | TCP port. |
| `CLAMD_SOCKET` | _(unset)_ | Tier-2 (clamav) | Unix socket path; takes precedence over TCP when set. |

**Tier-1 (sharp + ffmpeg) processors have NO env-configured network endpoints** — they're in-process; misconfiguration is impossible.

**Tier-2 processors fall back to the safe-fail production stub when the env var is unset.** A live deployment without `LIBREOFFICE_SERVICE_URL` will see document jobs dead-letter cleanly (`PROCESSOR_FAILED` retryable → dead-letter at `maxAttempts`) instead of crashing the worker. A live deployment without `CLAMD_HOST` will see scanner jobs surface `SCANNER_INCONCLUSIVE` and STORAGE-7 will retry/dead-letter per its existing policy.

---

## 5. Compose service definitions (dev / QA)

The two sidecars below are **opt-in for live mode**. The dev stack defaults to `STORAGE_PROCESSOR_MODE=stub` (per `.env.example`), so neither sidecar is mandatory for laptop development.

When an operator flips `STORAGE_PROCESSOR_MODE=live` in `.env.dev.local`, they MUST also start the sidecars by passing the live processors profile:

```bash
docker compose --env-file .env.dev.local \
  -f docker-compose.dev.yml \
  -f infra/compose/storage-live-processors.yml \
  up -d
```

The draft sidecar overlay lives at `xynes/xynes-infra/infra/compose/storage-live-processors.yml` (see that file for the canonical YAML). Key shape:

```yaml
services:
  libreoffice-sidecar:
    image: lscr.io/linuxserver/libreoffice:7.6.7
    # ...
  clamav-clamd:
    image: clamav/clamav:1.3
    # ...
  clamav-freshclam:
    image: clamav/clamav:1.3
    command: ["freshclam", "--daemon", "--foreground"]
    # ...
  storage-service:
    # Inherits from docker-compose.dev.yml; only adds env + depends_on
    environment:
      - LIBREOFFICE_SERVICE_URL=http://libreoffice-sidecar:8100
      - CLAMD_HOST=clamav-clamd
      - CLAMD_PORT=3310
    depends_on:
      - libreoffice-sidecar
      - clamav-clamd
```

The full file enforces:
- Pinned image tags (no `:latest`).
- Read-only root filesystem on both sidecars.
- `cap_drop: [ALL]` (no Linux capabilities granted).
- `security_opt: [no-new-privileges:true]`.
- Resource limits matching `xynes/xynes-infra/infra/release/ENVIRONMENTS.md` (sidecars are NOT counted against the storage-service RAM budget; they are documented as separate line items in the live-mode footnote).
- Named volume `clamav-defs` shared between `clamav-clamd` (read-only mount) and `clamav-freshclam` (read-write mount).

---

## 6. Kubernetes draft manifests (future)

Kubernetes is **out of scope for MVP** per `K8S-READINESS-CHECKLIST.md`. Draft manifests live at `xynes/xynes-infra/infra/release/deployment-posture/k8s/` so that when the K3s migration runs (§6 of the K8s readiness checklist), the sidecar topology is already designed:

```
xynes/xynes-infra/infra/release/deployment-posture/k8s/
├── README.md
├── 00-namespace.yaml
├── 10-libreoffice-sidecar.deployment.yaml
├── 11-libreoffice-sidecar.service.yaml
├── 20-clamav-clamd.deployment.yaml
├── 21-clamav-clamd.service.yaml
├── 22-clamav-freshclam.deployment.yaml
├── 30-clamav-defs.persistentvolumeclaim.yaml
└── 40-networkpolicy.yaml
```

The K8s manifests apply these constraints:
- **Multi-container pod for storage-service + sidecars.** Reduces network policy surface to one `Pod` boundary. The sidecars listen on `localhost` from the storage-service container's POV.
  - _Alternative considered:_ separate Deployments + ClusterIP Services. Rejected for MVP-style K3s because (a) it requires a NetworkPolicy default-deny per namespace, (b) the per-call latency cost is higher, (c) the manifest count doubles. Re-evaluate at the multi-replica step (§6.3 of the K8s readiness checklist).
- **Pod security context:** `runAsNonRoot: true`, `readOnlyRootFilesystem: true`, `allowPrivilegeEscalation: false`, `seccompProfile: { type: RuntimeDefault }`, `capabilities: { drop: ["ALL"] }`.
- **NetworkPolicy default-deny** at the namespace level; explicit allow rules for:
  - storage-service → libreoffice-sidecar (TCP 8100)
  - storage-service → clamav-clamd (TCP 3310)
  - clamav-freshclam → 0.0.0.0/0 (egress to `database.clamav.net` for definition refresh — **the only sidecar with external egress**)
- **Resource requests/limits** matching the dev compose budget; live-mode storage-service request raises from `256m` → `512m` per the live-mode footnote in `ENVIRONMENTS.md`.

The K8s drafts are documentation-grade only — they pass `kubectl apply --dry-run=client` for syntax validation but are not deployed by any CI pipeline.

---

## 7. Cold-start + memory budget

| Posture | Image size | Cold start | Memory (idle) | Memory (per concurrent job) |
|---|---|---|---|---|
| Storage-service (Tier-1 only) | ≤ 200 MB | < 3 s | ~80 MB | + ~50 MB (image) / ~150 MB (video) |
| LibreOffice sidecar | ~600 MB (image + JRE warm-up) | ~5 s | ~250 MB (warm soffice) | + ~100 MB per document |
| clamav-clamd sidecar | ~400 MB (image + defs) | ~10 s (def load) | ~300 MB (in-memory defs) | ~0 (streaming) |
| clamav-freshclam sidecar | ~250 MB (image only) | < 3 s | ~50 MB | n/a (background only) |

The storage-service image budget of ≤ 200 MB is the **hard constraint** from §3 of the FU-E acceptance criteria. The combined live-mode footprint per pod (storage-service + 3 sidecars) is ~1.5 GB total — significantly above the MVP single-VPS stub-mode budget. Per `ENVIRONMENTS.md` footnote `[^storage-stub]`, the live-mode RAM allocation needs a re-benchmark before flip; expect roughly 512m / 1024m for QA / Prod when live processors are wired.

---

## 8. Security posture

### Sidecar least-privilege checklist

For both `libreoffice-sidecar` and `clamav-clamd`:

- [x] `runAsNonRoot: true` (image's default UID; no root inside the container).
- [x] `readOnlyRootFilesystem: true` (writes only to a mounted `tmpfs` for per-request scratch).
- [x] `allowPrivilegeEscalation: false`.
- [x] `cap_drop: [ALL]` — no Linux capabilities granted.
- [x] `seccomp: RuntimeDefault` (drops the default-deny syscall set).
- [x] No host volume mounts (Postgres data volumes are the only exception in the wider stack; sidecars get none).
- [x] No host network — pod-local network only.
- [x] No public ingress — Caddy (the only host-bound process per `RELEASE-STRATEGY.md` §3.2) does NOT proxy to the sidecars.

### LibreOffice macro execution

LibreOffice's macro engine is a known RCE attack surface against malicious document inputs. **Macros are disabled at the container env level**, NOT via a CLI flag — `--disable-macros` is NOT part of LibreOffice's [official start-parameters list](https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html), so relying on it would be a silent no-op and would violate this invariant.

The sidecar sets `SAL_DISABLE_MACROS=1` in the container environment (canonical compose overlay line 50; K8s deployment manifest line 41), which LibreOffice honours globally for all `soffice` invocations within the container. This is **enforced at container startup**, not per-request, so a hostile document cannot bypass it. The actual `soffice` invocation inside the sidecar takes the standard supported flags only:

```
soffice --headless --norestore --convert-to png:writer_png_Export --outdir /tmp/<uuid>/ /tmp/<uuid>/input
```

Macros are disabled **globally** at the container env level, not per-request. A document carrying macros has them stripped before render.

> **Defense in depth (future hardening).** A locked LibreOffice user-profile / registrymodifications.xcu can additionally pin `Macro.Security = 4` (Very High) so even a hostile invocation that unsets `SAL_DISABLE_MACROS` cannot run macros. This is a follow-up for FU-C's sidecar image — the env-var approach is sufficient for MVP because the sidecar runs read-only-root with `cap_drop: [ALL]` (no way to override the container env from inside).

### clamav definition refresh

`freshclam` is the **only** sidecar with external egress (`database.clamav.net`). The NetworkPolicy (K8s) / docker network (Compose) explicitly allows ONLY this egress; `clamd` has no internet reach. A compromised `freshclam` cannot exfiltrate scanned bytes because (a) it doesn't see them — `clamd` does — and (b) the shared volume only carries definitions (read-only mount from `clamd`'s side).

### Bytes never touch disk

- **sharp:** in-memory buffer → in-memory buffer (FU-A).
- **ffmpeg:** stdin → stdout pipes (FU-B planned).
- **LibreOffice:** input bytes written to a `tmpfs`-mounted per-request directory; deleted in a `finally` block on the storage-service side. The directory is **not host-mounted** — it lives only inside the sidecar's filesystem.
- **clamav:** `INSTREAM` protocol streams bytes through the TCP socket; no temp file.

A sidecar OOM kill that leaves a residual `tmpfs` mount loses the bytes when the sidecar restarts (tmpfs is RAM-backed).

---

## 9. Operator rollout sequence

After FU-A + FU-E land:

1. Operator flips `STORAGE_PROCESSOR_MODE=live` in `xynes-infra/.env.dev.local`.
2. Operator restarts storage-service with the live-processors overlay:
   ```bash
   cd xynes/xynes-infra
   docker compose --env-file .env.dev.local \
     -f docker-compose.dev.yml \
     -f infra/compose/storage-live-processors.yml \
     up -d storage-service libreoffice-sidecar clamav-clamd clamav-freshclam
   ```
3. Verify `storage.service.ready` log emits `"processorMode": "live"`.
4. Verify `clamd PING` from inside the storage-service container:
   ```bash
   docker compose exec storage-service sh -c 'echo "PING" | nc clamav-clamd 3310'
   # expected: PONG
   ```
5. Verify LibreOffice sidecar reachability (TCP-level only until FU-C ships the HTTP shim — see §3):
   ```bash
   docker compose exec storage-service sh -c 'nc -z libreoffice-sidecar 8100 && echo OK'
   # expected: OK
   # Once FU-C lands the Bun HTTP shim, this upgrades to:
   #   docker compose exec storage-service curl -sf http://libreoffice-sidecar:8100/health
   ```
6. Re-run the smoke harness:
   ```bash
   bash scripts/smoke-universal-storage.sh --full --provider r2
   ```
   Every variant landed on R2 MUST be `> 1024` bytes (Bug 1 regression guard).

This sequence is **NOT** automated by FU-E. FU-E ships the posture decision, the compose overlay, the K8s draft, and the runbook entry. The operator step is the manual rollout gate.

---

## 10. Out of scope

- **Helm chart authoring** — defer to ops (per FU-E acceptance criteria).
- **Multi-region deployment topology** — defer to a future scale story.
- **Auto-scaling policies** — defer to ops.
- **Production secret-management for sidecar env vars** — covered by the STORAGE-FU-3 hosted-secret-manager follow-ups.
- **Sidecar binary installation in CI** — the fixture-based integration suite (FU-F) handles CI bring-up; FU-E is decision-only.
- **Per-replica horizontal-pod-autoscaling** — defer to the K3s multi-replica step.
- **Public-cloud managed scanner alternatives** (e.g. ClamAV-as-a-service, content-scanning SaaS) — defer until a customer asks for it.

---

## 11. Related documentation

- `xynes/xynes-infra/docs/plans/2026-05-27-storage-followups-combined.md` §6 — STORAGE-FU-5-FU-E plan.
- `xynes/xynes-storage-service/DEVELOPER.md` "Deployment Posture (STORAGE-FU-5-FU-E)" — short index pointing here.
- `xynes/xynes-infra/infra/compose/storage-live-processors.yml` — Compose overlay for the sidecars.
- `xynes/xynes-infra/infra/release/deployment-posture/k8s/README.md` — K8s draft manifests.
- `xynes/xynes-infra/infra/release/K8S-READINESS-CHECKLIST.md` — broader K8s migration audit.
- `xynes/xynes-infra/infra/release/ENVIRONMENTS.md` §4 — port table + live-mode RAM footnote.
