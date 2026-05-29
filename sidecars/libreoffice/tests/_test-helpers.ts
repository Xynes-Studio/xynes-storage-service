/**
 * STORAGE-FU-5-FU-G — shared test helpers.
 */

/**
 * Build a syntactically-valid PNG with the given dimensions in the
 * IHDR. Enough bytes for `isPngHeader` + `parsePngDimensions` to
 * succeed.
 */
export function pngBytesForTest(width: number, height: number, totalLen = 32): Uint8Array {
  const buf = new Uint8Array(totalLen);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buf.set([0x00, 0x00, 0x00, 0x0d], 8);
  buf.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(buf.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return buf;
}
