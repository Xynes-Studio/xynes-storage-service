import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type net from 'node:net';
import {
  __forTesting__,
  ClamavMalwareScanner,
  DEFAULT_CLAMD_HOST,
  DEFAULT_CLAMD_PORT,
  DEFAULT_CLAMD_TIMEOUT_MS,
} from '../../../src/infra/processors/clamav-scanner';

interface FakeSocketOptions {
  readonly responseText: string;
  readonly closeAfterResponse?: boolean;
  readonly noResponse?: boolean;
}

class FakeSocket extends EventEmitter {
  public destroyed = false;
  public writable = true;
  private requestBuffer = Buffer.alloc(0);
  private readonly options: FakeSocketOptions;
  public scannedPayloads: Uint8Array[] = [];

  constructor(options: FakeSocketOptions) {
    super();
    this.options = options;
  }

  write(chunk: Uint8Array | string, cb?: (err?: Error) => void): boolean {
    const piece = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    this.requestBuffer = Buffer.concat([this.requestBuffer, piece]);
    this.tryEmitResponse();
    cb?.();
    return true;
  }

  end(): void {
    this.destroyed = true;
    this.writable = false;
    this.emit('close');
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.writable = false;
    this.emit('close');
  }

  private tryEmitResponse(): void {
    const marker = Buffer.from('zINSTREAM\0');
    const markerIndex = this.requestBuffer.indexOf(marker);
    if (markerIndex < 0) return;

    let cursor = markerIndex + marker.length;
    const chunks: Buffer[] = [];

    for (;;) {
      if (this.requestBuffer.byteLength < cursor + 4) return;
      const length = this.requestBuffer.readUInt32BE(cursor);
      cursor += 4;
      if (length === 0) {
        const payload = new Uint8Array(Buffer.concat(chunks));
        this.scannedPayloads.push(payload);
        this.requestBuffer = this.requestBuffer.subarray(cursor);

        if (!this.options.noResponse) {
          this.emit('data', Buffer.from(`${this.options.responseText}\0`, 'utf8'));
          if (this.options.closeAfterResponse) {
            this.end();
          }
        }
        return;
      }

      if (this.requestBuffer.byteLength < cursor + length) return;
      chunks.push(this.requestBuffer.subarray(cursor, cursor + length));
      cursor += length;
    }
  }
}

interface FactoryState {
  calls: Array<net.NetConnectOpts>;
  sockets: FakeSocket[];
}

function makeFactory(options: FakeSocketOptions, state: FactoryState) {
  return {
    async connect(connectOptions: net.NetConnectOpts): Promise<FakeSocket> {
      state.calls.push(connectOptions);
      const socket = new FakeSocket(options);
      state.sockets.push(socket);
      return socket;
    },
  };
}

describe('clamav-scanner __forTesting__ helpers', () => {
  test('exports stable defaults', () => {
    expect(DEFAULT_CLAMD_HOST).toBe('clamav-clamd');
    expect(DEFAULT_CLAMD_PORT).toBe(3310);
    expect(DEFAULT_CLAMD_TIMEOUT_MS).toBe(10_000);
  });

  test('parseClamdResponse maps clean response', () => {
    expect(__forTesting__.parseClamdResponse('stream: OK')).toEqual({ verdict: 'clean' });
  });

  test('parseClamdResponse maps infected response with signature', () => {
    expect(__forTesting__.parseClamdResponse('stream: Eicar-Test-Signature FOUND')).toEqual({
      verdict: 'infected',
      signature: 'Eicar-Test-Signature',
    });
  });

  test('parseClamdResponse maps unknown/empty response to unknown', () => {
    expect(__forTesting__.parseClamdResponse('stream: ERROR')).toEqual({ verdict: 'unknown' });
    expect(__forTesting__.parseClamdResponse('')).toEqual({ verdict: 'unknown' });
  });
});

describe('ClamavMalwareScanner', () => {
  test('returns clean verdict and sends full payload bytes', async () => {
    const state: FactoryState = { calls: [], sockets: [] };
    const scanner = new ClamavMalwareScanner(
      { host: '127.0.0.1', port: 3310, timeoutMs: 100 },
      makeFactory({ responseText: 'stream: OK' }, state),
    );

    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const result = await scanner.scan({ bytes: payload });

    expect(result).toEqual({ verdict: 'clean' });
    expect(state.calls).toHaveLength(1);
    expect(state.sockets).toHaveLength(1);
    expect(Array.from(state.sockets[0]?.scannedPayloads[0] ?? [])).toEqual(Array.from(payload));
  });

  test('returns infected verdict with signature', async () => {
    const state: FactoryState = { calls: [], sockets: [] };
    const scanner = new ClamavMalwareScanner(
      { host: '127.0.0.1', port: 3310, timeoutMs: 100 },
      makeFactory({ responseText: 'stream: Win.Test.Signature FOUND' }, state),
    );

    const result = await scanner.scan({ bytes: new Uint8Array([9, 9, 9]) });
    expect(result).toEqual({ verdict: 'infected', signature: 'Win.Test.Signature' });
  });

  test('opens a fresh connection per scan (plain zINSTREAM is one-shot)', async () => {
    // STORAGE-FU-5-FU-D Codex P2 (line 164): plain `zINSTREAM` does
    // NOT support pooled reuse — clamd closes the connection after
    // the reply. The scanner now closes the socket after every scan
    // so the next call opens a fresh connection. (Pooled reuse would
    // require the `IDSESSION` framing.)
    const state: FactoryState = { calls: [], sockets: [] };
    const scanner = new ClamavMalwareScanner(
      { host: '127.0.0.1', port: 3310, timeoutMs: 100 },
      makeFactory({ responseText: 'stream: OK' }, state),
    );

    await scanner.scan({ bytes: new Uint8Array([1]) });
    await scanner.scan({ bytes: new Uint8Array([2]) });

    expect(state.calls).toHaveLength(2);
    expect(state.sockets).toHaveLength(2);
    expect(state.sockets[0]?.scannedPayloads).toHaveLength(1);
    expect(state.sockets[1]?.scannedPayloads).toHaveLength(1);
    expect(state.sockets[0]?.destroyed).toBe(true);
  });

  test('reconnects when the prior socket closes', async () => {
    const state: FactoryState = { calls: [], sockets: [] };
    const scanner = new ClamavMalwareScanner(
      { host: '127.0.0.1', port: 3310, timeoutMs: 100 },
      makeFactory({ responseText: 'stream: OK', closeAfterResponse: true }, state),
    );

    await scanner.scan({ bytes: new Uint8Array([1]) });
    await scanner.scan({ bytes: new Uint8Array([2]) });

    expect(state.calls).toHaveLength(2);
    expect(state.sockets[0]?.scannedPayloads).toHaveLength(1);
    expect(state.sockets[1]?.scannedPayloads).toHaveLength(1);
  });

  test('returns unknown on scanner timeout', async () => {
    const state: FactoryState = { calls: [], sockets: [] };
    const scanner = new ClamavMalwareScanner(
      { host: '127.0.0.1', port: 3310, timeoutMs: 20 },
      makeFactory({ responseText: 'stream: OK', noResponse: true }, state),
    );

    const result = await scanner.scan({ bytes: new Uint8Array([1]) });
    expect(result).toEqual({ verdict: 'unknown' });
  });

  test('returns unknown when the connect step exceeds the configured timeout', async () => {
    // STORAGE-FU-5-FU-D Codex P2 (line 170): a blackholed
    // `CLAMD_HOST`/`CLAMD_PORT` must NOT pin the worker for the
    // OS-level connect timeout. The scanner bounds connect by
    // `timeoutMs` and reports `unknown` so STORAGE-9 §3.6 fail-loud
    // posture holds.
    const slowFactory = {
      async connect(): Promise<FakeSocket> {
        // never resolves within the test's deadline
        return await new Promise<FakeSocket>(() => {});
      },
    };
    const scanner = new ClamavMalwareScanner(
      { host: '127.0.0.1', port: 3310, timeoutMs: 15 },
      slowFactory,
    );

    const result = await scanner.scan({ bytes: new Uint8Array([1]) });
    expect(result).toEqual({ verdict: 'unknown' });
  });

  test('discards a late socket if connect resolves after the timeout fired', async () => {
    // Defense-in-depth: if the connect promise resolves AFTER the
    // timeout has already rejected, the late socket must be destroyed
    // so it doesn't leak into the pool.
    let resolveConnect: ((socket: FakeSocket) => void) | undefined;
    const lateSocket = new FakeSocket({ responseText: 'stream: OK' });
    const slowFactory = {
      async connect(): Promise<FakeSocket> {
        return await new Promise<FakeSocket>((resolve) => {
          resolveConnect = resolve;
        });
      },
    };
    const scanner = new ClamavMalwareScanner(
      { host: '127.0.0.1', port: 3310, timeoutMs: 15 },
      slowFactory,
    );

    const verdict = await scanner.scan({ bytes: new Uint8Array([1]) });
    expect(verdict).toEqual({ verdict: 'unknown' });

    resolveConnect?.(lateSocket);
    // Let microtasks settle so the discard-and-destroy path runs.
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(lateSocket.destroyed).toBe(true);
  });

  test('uses socketPath connection options when provided', async () => {
    const state: FactoryState = { calls: [], sockets: [] };
    const scanner = new ClamavMalwareScanner(
      {
        socketPath: '/tmp/clamd.sock',
        host: '127.0.0.1',
        port: 3310,
        timeoutMs: 100,
      },
      makeFactory({ responseText: 'stream: OK' }, state),
    );

    const result = await scanner.scan({ bytes: new Uint8Array([1]) });
    expect(result).toEqual({ verdict: 'clean' });
    expect(state.calls[0]).toEqual({ path: '/tmp/clamd.sock' });
  });
});
