/** XYN-SEC-001: check the libraries actually loaded, including custom libvips builds. */
const MINIMUM_VERSIONS = Object.freeze({
  sharp: '0.35.5',
  heif: '1.23.5',
  vips: '8.18.7',
});

function meetsMinimum(actual: string | undefined, minimum: string): boolean {
  // Fail closed on missing versions, prereleases and unrecognised build strings.
  if (!actual || !/^\d+\.\d+\.\d+$/.test(actual)) return false;
  const parts = actual.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) return false;
  const floor = minimum.split('.').map(Number);
  for (let index = 0; index < floor.length; index += 1) {
    if (parts[index] > floor[index]) return true;
    if (parts[index] < floor[index]) return false;
  }
  return true;
}

export function assertSafeNativeImageRuntime(
  versions: Readonly<Record<string, string | undefined>>,
): void {
  for (const [library, minimum] of Object.entries(MINIMUM_VERSIONS)) {
    if (!meetsMinimum(versions[library], minimum)) {
      // Never echo arbitrary native build strings into logs or error responses.
      throw new Error('UNSAFE_NATIVE_IMAGE_RUNTIME');
    }
  }
}
