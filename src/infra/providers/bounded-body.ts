import { ProviderAdapterError } from './errors';

function isByteStream(body: unknown): body is AsyncIterable<unknown> {
  return (
    typeof body === 'object' &&
    body !== null &&
    Symbol.asyncIterator in body &&
    typeof body[Symbol.asyncIterator] === 'function'
  );
}

/** Best-effort disposal must never replace a pre-redacted validation error. */
export async function disposeProviderBody(body: unknown): Promise<void> {
  try {
    if (body instanceof ReadableStream) {
      if (!body.locked) await body.cancel();
    } else if (typeof body === 'object' && body !== null && 'destroy' in body) {
      if (typeof body.destroy === 'function') body.destroy();
    } else if (isByteStream(body)) {
      await body[Symbol.asyncIterator]().return?.();
    }
  } catch {
    // Cancellation failures carry no useful client-facing detail.
  }
}

/** Count chunks before retaining them; never call whole-body conversion APIs. */
export async function readBoundedProviderBody(
  body: unknown,
  maxBytes: number,
  expectedByteSize?: number,
): Promise<Uint8Array> {
  let stream = body;
  if (
    typeof stream === 'object' &&
    stream !== null &&
    'transformToWebStream' in stream &&
    typeof stream.transformToWebStream === 'function' &&
    !isByteStream(stream)
  ) {
    try {
      stream = stream.transformToWebStream();
    } catch (err) {
      await disposeProviderBody(body);
      throw err;
    }
  }

  // Grow one buffer instead of retaining an unbounded count of tiny chunks.
  // Capacity never exceeds the declared/policy limit; growth starts at 64 KiB.
  let buffer = new Uint8Array(Math.min(maxBytes, 64 * 1024));
  let length = 0;
  function retain(chunk: unknown): void {
    if (!(chunk instanceof Uint8Array)) {
      throw new ProviderAdapterError('PROVIDER_OPERATION_FAILED');
    }
    if (chunk.byteLength > maxBytes - length) {
      throw new ProviderAdapterError('PROVIDER_OBJECT_TOO_LARGE');
    }
    const nextLength = length + chunk.byteLength;
    if (nextLength > buffer.byteLength) {
      const grown = new Uint8Array(Math.min(maxBytes, Math.max(nextLength, buffer.byteLength * 2)));
      grown.set(buffer.subarray(0, length));
      buffer = grown;
    }
    buffer.set(chunk, length);
    length = nextLength;
  }

  try {
    if (stream instanceof ReadableStream) {
      const reader = stream.getReader();
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          retain(next.value);
        }
      } catch (err) {
        try {
          await reader.cancel();
        } catch {
          // Keep the original safe error.
        }
        throw err;
      } finally {
        reader.releaseLock();
      }
    } else if (isByteStream(stream)) {
      for await (const chunk of stream) retain(chunk);
    } else if (stream != null) {
      throw new ProviderAdapterError('PROVIDER_OPERATION_FAILED');
    }
    if (expectedByteSize !== undefined && length !== expectedByteSize) {
      throw new ProviderAdapterError('PROVIDER_OBJECT_SIZE_MISMATCH');
    }
    return buffer.subarray(0, length);
  } catch (err) {
    await disposeProviderBody(stream);
    throw err;
  }
}
