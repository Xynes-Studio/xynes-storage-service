import { ProviderAdapterError } from '../../../../infra/providers/errors';
import { isValidObjectByteSize, maxBytesForContentType } from '../../objects/byte-size-policy';
import { RunnerExecutionError, RunnerInputError } from './errors';
import type { ProviderObjectIO } from './ports';

/** Shared guard for every scanner and native processor entry point. */
export async function readObjectForProcessing(
  providerIO: ProviderObjectIO,
  object: {
    contentType: string;
    byteSize: number;
    providerObjectKey: string;
    workspaceId: string;
    providerId: string;
  },
  maxInputBytes?: number,
): Promise<Uint8Array> {
  const cap = Math.min(maxBytesForContentType(object.contentType), maxInputBytes ?? Infinity);
  if (!isValidObjectByteSize(object.byteSize)) {
    throw new RunnerInputError('PROFILE_GUARD_REJECTED');
  }
  if (object.byteSize > cap) throw new RunnerInputError('OVER_MAX_BYTES');

  let bytes: Uint8Array;
  try {
    bytes = await providerIO.readObject({
      objectKey: object.providerObjectKey,
      workspaceId: object.workspaceId,
      providerId: object.providerId,
      maxBytes: Math.min(object.byteSize, cap),
      expectedByteSize: object.byteSize,
    });
  } catch (err) {
    if (err instanceof ProviderAdapterError) {
      if (err.code === 'PROVIDER_OBJECT_TOO_LARGE') throw new RunnerInputError('OVER_MAX_BYTES');
      if (err.code === 'PROVIDER_OBJECT_SIZE_MISMATCH') {
        throw new RunnerInputError('PROFILE_GUARD_REJECTED');
      }
    }
    throw new RunnerExecutionError('PROCESSOR_FAILED', { retryable: true });
  }
  // Alternate IO implementations may ignore limits; never trust their result.
  if (bytes.byteLength > cap) throw new RunnerInputError('OVER_MAX_BYTES');
  if (bytes.byteLength !== object.byteSize) throw new RunnerInputError('PROFILE_GUARD_REJECTED');
  return bytes;
}
