# STORAGE-FU-5-FU-F integration fixtures

Committed binary test fixtures consumed by the per-processor integration
suites under `tests/integration/processors/*.integration.test.ts`.

## Why committed binaries

Per STORAGE-9 §3 + the combined follow-ups plan §15 ("Security
invariants"):

- **Fixtures MUST be deterministic.** Regeneration at test runtime
  (e.g. calling `ffmpeg` from inside the test process) introduces
  binary-encoder non-determinism, breaks reproducibility, and adds an
  implicit dependency on a working binary toolchain in CI just to
  produce the fixture.
- **Fixtures MUST NOT touch the network.** Downloading a sample at
  test time would let an MITM mutate the test corpus.
- **Fixtures MUST be small.** A 4 KiB JPEG + a 28 KiB MP4 + a 1 KiB
  PDF stay well under the per-processor hard caps (50 MiB image,
  2 GiB video, 100 MiB document) so the runner exercises the
  happy path, not the byte-cap negative path.

## File-by-file provenance

| Fixture       | Size       | Generator                                | Notes |
|---------------|------------|------------------------------------------|-------|
| `sample.jpg`  | 599 bytes  | `sharp` (256×192 solid colour) + hand-spliced APP1 segment | Carries a synthetic GPS sub-IFD (tag `0x8825`) so `SharpImageProcessor.detectGpsExif` returns `true`. The post-encode JPEG MUST NOT carry the tag (EXIF strip invariant). |
| `sample.png`  | 1407 bytes | `sharp` (256×192 solid colour)            | Clean control fixture — no EXIF, no metadata. |
| `sample.mp4`  | 28510 bytes| `ffmpeg testsrc=duration=2 + sine`        | 2-second H.264/AAC at 160×120 with `comment=STORAGE_FU_5_FU_F_FIXTURE_CANARY` + `title=STORAGE-FU-5-FU-F fixture`. The post-transcode MP4 MUST NOT carry the canary string (metadata strip invariant). |
| `sample.pdf`  | 1334 bytes | hand-rolled minimal PDF                   | 3 pages each carrying a `Page N` text string, plus a `/Title` + `/Author` + `/Creator` document Info dictionary. The post-conversion preview MUST NOT carry the strings (metadata strip invariant). |
| `eicar.txt`   | 68 bytes   | the standard EICAR string                 | The canonical antivirus test vector (since 1991) recognised by every commercial AV product. **NOT real malware.** Triggers `verdict: 'infected'` from any properly-configured clamd. |

## Regenerating the fixtures

A maintainer can regenerate the fixtures from scratch:

```bash
cd xynes-storage-service
bun run tests/integration/processors/fixtures/_generate.ts
```

The script is **idempotent** — it overwrites any existing file. The
output should be byte-stable across sharp + ffmpeg versions (modulo
encoder quirks); if regeneration produces noticeably different bytes
the maintainer should commit the new bytes AND update the size column
above.

The generation script itself (`_generate.ts`) is committed as
documentation; it is NOT loaded by any test (the integration suite
reads the committed binaries only).

## Security notes

- **EICAR is the standard test vector**, not real malware. A hostile
  AV agent that flags this directory should be considered a regression
  in the AV agent, not the fixture.
- Fixtures contain ONLY synthetic test inputs. There are no real-world
  PII, copyrighted media, or production data.
- The `eicar.txt` string is split across two halves in the generator
  script so the script source itself doesn't trip naive AV scanners
  at edit time.
