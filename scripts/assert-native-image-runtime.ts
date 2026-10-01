import sharp from 'sharp';
import { assertSafeNativeImageRuntime } from '../src/infra/processors/native-image-runtime';

assertSafeNativeImageRuntime(sharp.versions);
if (!sharp.format.heif.input.buffer || !sharp.format.heif.output.buffer) {
  throw new Error('REQUIRED_HEIF_CODEC_UNAVAILABLE');
}
console.log(
  JSON.stringify({
    platform: process.platform,
    arch: process.arch,
    sharp: sharp.versions.sharp,
    libheif: sharp.versions.heif,
    libvips: sharp.versions.vips,
    heif: sharp.format.heif,
  }),
);
