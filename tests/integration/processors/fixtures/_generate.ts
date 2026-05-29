/**
 * STORAGE-FU-5-FU-F — fixture generation script (one-shot).
 *
 * Generates the four committed binary fixtures under
 * `tests/integration/processors/fixtures/`:
 *
 *   - sample.jpg — 256x192 JPEG with embedded GPS EXIF metadata.
 *   - sample.png — 256x192 PNG (simple control fixture).
 *   - sample.mp4 — 2-second H.264/AAC MP4 with embedded `comment`
 *     metadata (the FU-B canary). Requires `ffmpeg` on PATH.
 *   - sample.pdf — 3-page PDF with document properties (Title, Author).
 *
 * Eicar.txt is committed as a STATIC plaintext string — it is the
 * standard antivirus test vector since 1991, recognised by every AV
 * product. NOT real malware.
 *
 * THIS SCRIPT IS NOT PART OF THE TEST SUITE.
 *
 * It runs ONCE at fixture-creation time to produce the committed
 * binaries. The integration tests under
 * `tests/integration/processors/*.integration.test.ts` consume the
 * committed bytes only — they NEVER regenerate fixtures at test time
 * (that would be a non-determinism + external-network risk per
 * STORAGE-9 invariants).
 *
 * Re-running the script regenerates the binaries deterministically so
 * a maintainer can verify byte parity if needed:
 *
 *   bun run tests/integration/processors/fixtures/_generate.ts
 *
 * The script is idempotent — if any fixture already exists it is
 * overwritten.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import sharp from 'sharp';

const FIXTURES_DIR = dirname(new URL(import.meta.url).pathname);

// ─── sample.jpg — JPEG with embedded GPS EXIF ──────────────────────────────
// sharp's `.withExif({ GPS: ... })` API doesn't reliably embed a real
// GPS sub-IFD pointer into a synthetic source. So we generate a clean
// JPEG (over a deterministic-noise raw buffer so it compresses to a
// realistic size — solid-colour fixtures shrink to ~150 bytes per
// variant which is below the FU-A Bug 1 sanity floor) and splice a
// hand-built APP1 segment containing the standard 0x8825 GPS sub-IFD
// pointer (little-endian byte order). This matches the byte pattern
// real-world camera/phone JPEGs use, so the `detectGpsExif` heuristic
// in `SharpImageProcessor` works against the fixture out of the box.
function deterministicNoise(width: number, height: number, channels: number): Buffer {
  const buf = Buffer.alloc(width * height * channels);
  // xorshift32 — deterministic but high-frequency, defeats most
  // lossy compressors below ~50% quality. Same generator as the
  // FU-A Bug 1 regression guard so fixture + unit test stay aligned.
  let seed = 0x12345678;
  for (let i = 0; i < buf.length; i += 1) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    buf[i] = seed & 0xff;
  }
  return buf;
}

async function generateSampleJpeg(): Promise<void> {
  const raw = deterministicNoise(256, 192, 3);
  const baseJpeg = await sharp(raw, {
    raw: { width: 256, height: 192, channels: 3 },
  })
    .jpeg({ quality: 90 })
    .toBuffer();

  // Hand-build a minimal APP1 segment with EXIF marker, TIFF header
  // little-endian, IFD0 with ONE entry whose tag is 0x8825 (GPS).
  // Real cameras embed a GPS sub-IFD here — for our test vector
  // we just need the 0x8825 tag to appear so `detectGpsExif`
  // returns true.
  // Bytes (little-endian where applicable):
  //   FF E1 LEN_HI LEN_LO 'Exif' 0 0
  //   TIFF: 49 49 2A 00 (LE marker) 08 00 00 00 (IFD0 offset = 8)
  //   IFD0: 01 00 (1 entry)
  //         25 88 (tag 0x8825 GPS)
  //         04 00 (LONG type)
  //         01 00 00 00 (count=1)
  //         1A 00 00 00 (value = offset 26, where the empty sub-IFD lives)
  //         00 00 00 00 (next IFD offset = 0)
  //   GPS sub-IFD at offset 26: 00 00 (zero entries) + 00 00 00 00 (next)
  const exifPayload = Buffer.from([
    0x45,
    0x78,
    0x69,
    0x66,
    0x00,
    0x00, // "Exif\0\0"
    0x49,
    0x49,
    0x2a,
    0x00, // TIFF LE marker
    0x08,
    0x00,
    0x00,
    0x00, // IFD0 offset = 8
    0x01,
    0x00, // 1 entry
    0x25,
    0x88,
    0x04,
    0x00,
    0x01,
    0x00,
    0x00,
    0x00,
    0x1a,
    0x00,
    0x00,
    0x00, // 0x8825 GPS pointer
    0x00,
    0x00,
    0x00,
    0x00, // next IFD = 0
    0x00,
    0x00, // GPS sub-IFD: 0 entries
    0x00,
    0x00,
    0x00,
    0x00, // next = 0
  ]);
  // APP1 segment length = 2 (length bytes itself) + exifPayload.length
  const segmentLength = 2 + exifPayload.length;
  const app1 = Buffer.concat([
    Buffer.from([0xff, 0xe1, (segmentLength >> 8) & 0xff, segmentLength & 0xff]),
    exifPayload,
  ]);

  // Splice the APP1 segment in AFTER the SOI marker (first 2 bytes).
  const withExif = Buffer.concat([baseJpeg.subarray(0, 2), app1, baseJpeg.subarray(2)]);
  writeFileSync(join(FIXTURES_DIR, 'sample.jpg'), withExif);
  // eslint-disable-next-line no-console
  console.log(`sample.jpg: ${withExif.length} bytes (with synthetic GPS EXIF)`);
}

// ─── sample.png — clean control PNG ────────────────────────────────────────
async function generateSamplePng(): Promise<void> {
  const raw = deterministicNoise(256, 192, 4);
  const png = await sharp(raw, {
    raw: { width: 256, height: 192, channels: 4 },
  })
    .png({ compressionLevel: 6 })
    .toBuffer();
  writeFileSync(join(FIXTURES_DIR, 'sample.png'), png);
  // eslint-disable-next-line no-console
  console.log(`sample.png: ${png.length} bytes`);
}

// ─── eicar.txt — standard EICAR antivirus test string ──────────────────────
// Per https://en.wikipedia.org/wiki/EICAR_test_file — the canonical
// 68-byte string recognised by every commercial antivirus product.
// NOT real malware. The string is split here so a hostile IDE / AV
// agent doesn't mark this script as infected at edit time.
function generateEicar(): void {
  const part1 = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}';
  const part2 = '$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
  const eicar = part1 + part2;
  writeFileSync(join(FIXTURES_DIR, 'eicar.txt'), eicar, 'utf-8');
  // eslint-disable-next-line no-console
  console.log(`eicar.txt: ${eicar.length} bytes (standard AV test vector)`);
}

// ─── sample.pdf — minimal 3-page PDF ───────────────────────────────────────
// Hand-rolled minimal PDF. Real production PDFs would be generated by
// `pdf-lib`, but we avoid the runtime dependency for a fixture-only
// script. The PDF has 3 pages each carrying a "Page N" text string
// and document Info dictionary (Title, Author) so the FU-C runner
// can prove metadata-stripping on conversion.
function generateSamplePdf(): void {
  const objects: string[] = [];
  // Object 1: Catalog
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  // Object 2: Pages collection
  objects.push('<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>');
  // Object 3: Page 1
  objects.push(
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>',
  );
  // Object 4: Page 1 content
  objects.push('<< /Length 44 >>\nstream\nBT /F1 24 Tf 100 700 Td (Page 1) Tj ET\nendstream');
  // Object 5: Page 2
  objects.push(
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>',
  );
  // Object 6: Page 2 content
  objects.push('<< /Length 44 >>\nstream\nBT /F1 24 Tf 100 700 Td (Page 2) Tj ET\nendstream');
  // Object 7: Page 3
  objects.push(
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 8 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>',
  );
  // Object 8: Page 3 content
  objects.push('<< /Length 44 >>\nstream\nBT /F1 24 Tf 100 700 Td (Page 3) Tj ET\nendstream');
  // Object 9: Document Info (Title, Author — the "metadata" the
  // FU-C runner must strip during conversion).
  objects.push(
    '<< /Title (STORAGE-FU-5-FU-F fixture) /Author (xynes-storage-service tests) /Creator (fixtures/_generate.ts) >>',
  );

  // Build the file body + xref table.
  let body = '%PDF-1.4\n%\xc4\xe5\xf2\xe5\xeb\xa7\xf3\xa0\xd0\xc4\xc6\n';
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    body += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 9 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  // Write as latin1 so the binary marker bytes survive.
  writeFileSync(join(FIXTURES_DIR, 'sample.pdf'), Buffer.from(body, 'latin1'));
  // eslint-disable-next-line no-console
  console.log(`sample.pdf: ${body.length} bytes (3 pages + Info dict)`);
}

// ─── sample.mp4 — 2-second H.264/AAC MP4 with embedded comment ─────────────
// Uses the locally-installed `ffmpeg` binary. The integration suite
// REQUIRES the binary at test runtime; this generation script does
// the same and produces a deterministic 2-second clip.
async function generateSampleMp4(): Promise<void> {
  const ffmpegPath = process.env.STORAGE_FFMPEG_BIN ?? 'ffmpeg';
  const out = join(FIXTURES_DIR, 'sample.mp4');
  const args = [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=2:size=160x120:rate=24',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=2',
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '64k',
    '-metadata',
    'comment=STORAGE_FU_5_FU_F_FIXTURE_CANARY',
    '-metadata',
    'title=STORAGE-FU-5-FU-F fixture',
    out,
  ];
  const proc = Bun.spawn({
    cmd: [ffmpegPath, ...args],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`ffmpeg exited ${exitCode}; stderr: ${err.slice(0, 500)}`);
  }
  const stat = await Bun.file(out).size;
  // eslint-disable-next-line no-console
  console.log(`sample.mp4: ${stat} bytes (with title + comment canary)`);
}

// ─── Main ──────────────────────────────────────────────────────────────────
await generateSampleJpeg();
await generateSamplePng();
generateEicar();
generateSamplePdf();
await generateSampleMp4();
// eslint-disable-next-line no-console
console.log('All fixtures generated successfully.');
