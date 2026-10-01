import { classifyContentType } from './schemas';

export const DEFAULT_MAX_BYTE_SIZE = 5 * 1024 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_SCANNER_INPUT_BYTES = 64 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;

/** Shared upload and processing limits, independent of quality profile. */
export function maxBytesForContentType(contentType: string): number {
  if (
    [
      'application/zip',
      'application/x-zip-compressed',
      'application/gzip',
      'application/x-gzip',
      'application/x-tar',
      'application/x-7z-compressed',
      'application/vnd.rar',
      'application/x-rar-compressed',
      'application/x-bzip2',
      'application/x-xz',
      'application/zstd',
      'application/x-lzma',
      'application/x-cpio',
      'application/x-iso9660-image',
      'application/vnd.ms-cab-compressed',
      'application/x-apple-diskimage',
    ].includes(contentType.split(';', 1)[0]!.trim().toLowerCase())
  ) {
    return MAX_SCANNER_INPUT_BYTES;
  }
  switch (classifyContentType(contentType)) {
    case 'image':
      return MAX_IMAGE_BYTES;
    case 'video':
      return MAX_VIDEO_BYTES;
    case 'document':
      return MAX_DOCUMENT_BYTES;
    default:
      return DEFAULT_MAX_BYTE_SIZE;
  }
}

export function isValidObjectByteSize(byteSize: number): boolean {
  return Number.isSafeInteger(byteSize) && byteSize > 0;
}
