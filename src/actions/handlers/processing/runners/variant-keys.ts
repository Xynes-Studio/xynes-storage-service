/**
 * STORAGE-8 — derives the provider object key for a derivative variant.
 *
 * Variants live under a `variants/<role>/<extension>` segment off the
 * parent object's directory, NOT a sibling of the original. This:
 *   1. Keeps the original at its exact STORAGE-5 path unchanged.
 *   2. Makes variants enumerable per-object via a single prefix.
 *   3. Keeps the variant key worth its own AWS S3 key length budget
 *      (we already cap at 1024 bytes in STORAGE-5).
 *
 * Algorithm:
 *   Take the parent's directory prefix (everything up to the LAST `/`)
 *   and append `variants/<role>.<extension>` to it. The role + extension
 *   pair is closed-set, so the variant suffix is always short and ASCII.
 *
 * SECURITY: this function NEVER touches the original key bytes — the
 * variant key cannot collide with the original. Asserted by
 * `assertVariantKeyDistinctFromOriginal`.
 */
import type { VariantRole } from './profiles';

const EXTENSION_BY_CONTENT_TYPE: Readonly<Record<string, string>> = Object.freeze({
  'image/avif': 'avif',
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'video/mp4': 'mp4',
});

/** Resolves the canonical file extension for a variant content type. */
export function extensionForContentType(contentType: string): string {
  return EXTENSION_BY_CONTENT_TYPE[contentType.toLowerCase()] ?? 'bin';
}

/**
 * Build the provider object key for a derivative variant.
 *
 * Throws if the derived key equals the parent key (defense in depth —
 * the original must never be overwritten).
 */
export function deriveVariantObjectKey(input: {
  parentObjectKey: string;
  role: VariantRole;
  contentType: string;
}): string {
  const { parentObjectKey, role, contentType } = input;
  if (typeof parentObjectKey !== 'string' || parentObjectKey.length === 0) {
    throw new Error('deriveVariantObjectKey: parentObjectKey is required');
  }
  const lastSlash = parentObjectKey.lastIndexOf('/');
  const prefix = lastSlash >= 0 ? parentObjectKey.slice(0, lastSlash) : '';
  const ext = extensionForContentType(contentType);
  const candidate =
    prefix.length > 0 ? `${prefix}/variants/${role}.${ext}` : `variants/${role}.${ext}`;
  assertVariantKeyDistinctFromOriginal(candidate, parentObjectKey);
  return candidate;
}

export function assertVariantKeyDistinctFromOriginal(variantKey: string, parentKey: string): void {
  if (variantKey === parentKey) {
    throw new Error(
      'deriveVariantObjectKey: variant key collides with parent key (original would be overwritten)',
    );
  }
}
