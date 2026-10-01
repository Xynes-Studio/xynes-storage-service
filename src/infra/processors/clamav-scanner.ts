/**
 * STORAGE-FU-5-FU-D — ClamAV-backed MalwareScanner.
 *
 * This client sends bounded metadata plus INSTREAM to the archive supervisor over:
 *   - TCP (`host` + `port`), or
 *   - a unix socket path (`socketPath`, takes precedence).
 *
 * Security posture:
 *   - Never writes bytes to disk.
 *   - Never logs raw payloads, signatures, or socket errors.
 *   - Never coerces unknown scanner outcomes to clean.
 *   - Keeps at most one socket per scanner instance (worker) and
 *     reconnects when the supervisor closes a completed request.
 */
import net from 'node:net';
import { MAX_SCANNER_INPUT_BYTES } from '../../actions/handlers/objects/byte-size-policy';
import type {
  MalwareScanResult,
  MalwareScanner,
} from '../../actions/handlers/processing/runners/ports';

export const DEFAULT_CLAMD_HOST = 'clamav-clamd';
export const DEFAULT_CLAMD_PORT = 3310;
export const DEFAULT_CLAMD_TIMEOUT_MS = 25_000;
const DEFAULT_CHUNK_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024;

export interface ClamavMalwareScannerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly socketPath?: string;
  readonly timeoutMs?: number;
  readonly chunkBytes?: number;
  readonly maxInputBytes?: number;
}

interface SocketLike {
  destroyed: boolean;
  writable: boolean;
  write(chunk: Uint8Array | string, cb?: (err?: Error | null) => void): boolean;
  end(): void;
  destroy(error?: Error): void;
  on(event: 'close' | 'error', listener: (...args: unknown[]) => void): this;
  off(event: 'close' | 'error', listener: (...args: unknown[]) => void): this;
  once(event: 'error' | 'close', listener: (...args: unknown[]) => void): this;
  once(event: 'data', listener: (chunk: Buffer) => void): this;
  on(event: 'data', listener: (chunk: Buffer) => void): this;
  off(event: 'data', listener: (chunk: Buffer) => void): this;
}

interface SocketFactory {
  connect(options: net.NetConnectOpts): Promise<SocketLike>;
}

const defaultSocketFactory: SocketFactory = {
  connect(options) {
    return new Promise<SocketLike>((resolve, reject) => {
      const socket = net.createConnection(options);
      const onError = (err: Error) => {
        socket.off('connect', onConnect);
        reject(err);
      };
      const onConnect = () => {
        socket.off('error', onError);
        resolve(socket);
      };
      socket.once('error', onError);
      socket.once('connect', onConnect);
    });
  },
};

function parseClamdResponse(raw: string): MalwareScanResult {
  const text = raw.replace(/\0/g, '').trim();
  if (text.length === 0) return { verdict: 'unknown' };

  if (
    /^stream: (?:Heuristics\.Limits\.Exceeded\.|Xynes\.Archive\.Limit\.)[A-Za-z]+ FOUND$/.test(
      text,
    ) ||
    text === 'INSTREAM size limit exceeded. ERROR' ||
    text === 'stream: INSTREAM size limit exceeded. ERROR'
  ) {
    return { verdict: 'limit_exceeded' };
  }

  if (/^stream: .+ FOUND$/.test(text)) {
    const beforeFound = text.slice(0, text.indexOf(' FOUND')).trim();
    const signature = beforeFound.includes(':')
      ? beforeFound.slice(beforeFound.indexOf(':') + 1).trim()
      : beforeFound;
    return signature.length > 0 ? { verdict: 'infected', signature } : { verdict: 'infected' };
  }

  if (text === 'stream: OK') return { verdict: 'clean' };
  return { verdict: 'unknown' };
}

function isTerminalResponse(buffer: Buffer): boolean {
  return buffer.includes(0x00) || buffer.includes(0x0a);
}

function trimResponse(buffer: Buffer): string {
  let end = buffer.length;
  const zero = buffer.indexOf(0x00);
  const newline = buffer.indexOf(0x0a);
  if (zero >= 0) end = Math.min(end, zero);
  if (newline >= 0) end = Math.min(end, newline);
  return buffer.subarray(0, end).toString('utf8');
}

function chunkBytes(input: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < input.byteLength; i += size) {
    chunks.push(input.subarray(i, Math.min(i + size, input.byteLength)));
  }
  return chunks;
}

async function writeChunk(socket: SocketLike, chunk: Uint8Array | string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    socket.write(chunk, (err) => (err ? reject(err) : resolve()));
  });
}

export class ClamavMalwareScanner implements MalwareScanner {
  private readonly host: string;
  private readonly port: number;
  private readonly socketPath?: string;
  private readonly timeoutMs: number;
  private readonly chunkBytes: number;
  private readonly maxInputBytes: number;
  private readonly socketFactory: SocketFactory;
  private socket: SocketLike | null = null;
  private readonly socketDropHandler: () => void;
  private scanQueue: Promise<MalwareScanResult> = Promise.resolve({ verdict: 'clean' });

  constructor(
    options: ClamavMalwareScannerOptions = {},
    socketFactory: SocketFactory = defaultSocketFactory,
  ) {
    this.host = options.host ?? DEFAULT_CLAMD_HOST;
    this.port = options.port ?? DEFAULT_CLAMD_PORT;
    this.socketPath = options.socketPath?.trim() || undefined;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CLAMD_TIMEOUT_MS;
    this.chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    this.maxInputBytes = options.maxInputBytes ?? MAX_SCANNER_INPUT_BYTES;
    if (
      ![this.timeoutMs, this.chunkBytes, this.maxInputBytes].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      ) ||
      this.maxInputBytes > MAX_SCANNER_INPUT_BYTES
    ) {
      throw new Error('Invalid scanner limits');
    }
    this.socketFactory = socketFactory;
    this.socketDropHandler = () => {
      this.clearSocket();
    };
  }

  async scan(input: { bytes: Uint8Array; contentType?: string }): Promise<MalwareScanResult> {
    if (
      input.contentType !== undefined &&
      (!/^[\x21-\x7e]{1,255}$/.test(input.contentType) || !input.contentType.includes('/'))
    )
      return { verdict: 'limit_exceeded' };
    if (input.bytes.byteLength > this.maxInputBytes) return { verdict: 'limit_exceeded' };
    const run = this.scanQueue.then(
      () => this.scanOnce(input.bytes, input.contentType),
      () => this.scanOnce(input.bytes, input.contentType),
    );
    this.scanQueue = run;
    return run;
  }

  private async scanOnce(bytes: Uint8Array, contentType?: string): Promise<MalwareScanResult> {
    try {
      const socket = await this.getSocket();
      const response = await this.sendInstream(socket, bytes, contentType);
      // STORAGE-FU-5-FU-D Codex P2 (line 164): plain `zINSTREAM` is a
      // one-shot command — clamd closes the connection after sending
      // the reply. Pooling without `IDSESSION` framing creates a race
      // where a second scan can land on a half-closed socket. Always
      // reset after a successful scan so the next call opens a fresh
      // connection.
      this.resetSocket();
      return parseClamdResponse(response);
    } catch (err) {
      this.resetSocket();
      if (
        err instanceof Error &&
        (err.message === 'clamd response timeout' || err.message === 'clamd connect timeout')
      ) {
        return { verdict: 'unknown', retryable: false };
      }
      return { verdict: 'unknown' };
    }
  }

  private async getSocket(): Promise<SocketLike> {
    if (this.socket && !this.socket.destroyed && this.socket.writable) {
      return this.socket;
    }

    const connectOptions: net.NetConnectOpts = this.socketPath
      ? { path: this.socketPath }
      : { host: this.host, port: this.port };
    // STORAGE-FU-5-FU-D Codex P2 (line 170): bound the connect step by
    // the configured `timeoutMs` so a blackholed `CLAMD_HOST`/`CLAMD_PORT`
    // doesn't pin the worker for the OS-level connect timeout. The race
    // returns `unknown` to keep the STORAGE-9 §3.6 fail-loud posture.
    const socket = await this.connectWithTimeout(connectOptions);
    socket.on('close', this.socketDropHandler);
    socket.on('error', this.socketDropHandler);
    this.socket = socket;
    return socket;
  }

  private connectWithTimeout(connectOptions: net.NetConnectOpts): Promise<SocketLike> {
    return new Promise<SocketLike>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('clamd connect timeout'));
      }, this.timeoutMs);

      this.socketFactory.connect(connectOptions).then(
        (socket) => {
          if (settled) {
            // Timer already fired — discard the late socket so it
            // doesn't leak into the pool.
            try {
              socket.destroy();
            } catch {
              // best effort
            }
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve(socket);
        },
        (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error('clamd connect error'));
        },
      );
    });
  }

  private async sendInstream(
    socket: SocketLike,
    bytes: Uint8Array,
    contentType?: string,
  ): Promise<string> {
    const responsePromise = this.readResponse(socket);
    const sending = (async () => {
      if (contentType !== undefined) await writeChunk(socket, `zXYNES ${contentType}\0`);
      await writeChunk(socket, 'zINSTREAM\0');
      for (const chunk of chunkBytes(bytes, this.chunkBytes)) {
        const len = Buffer.allocUnsafe(4);
        len.writeUInt32BE(chunk.byteLength, 0);
        await writeChunk(socket, len);
        await writeChunk(socket, chunk);
      }
      const end = Buffer.allocUnsafe(4);
      end.writeUInt32BE(0, 0);
      await writeChunk(socket, end);
      return responsePromise;
    })();
    // A daemon may reject before consuming all input. Its verdict/deadline wins;
    // resetting the socket then stops outstanding writes. Both promises are handled.
    return Promise.race([responsePromise, sending]);
  }

  private readResponse(socket: SocketLike): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let settled = false;

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('clamd response timeout'));
      }, this.timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        socket.off('data', onData);
        socket.off('error', onError);
        socket.off('close', onClose);
      };

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      const onError = () => finish(() => reject(new Error('clamd socket error')));
      const onClose = () => {
        if (settled) return;
        const joined = total > 0 ? Buffer.concat(chunks, total) : Buffer.alloc(0);
        if (joined.byteLength > 0 && isTerminalResponse(joined)) {
          finish(() => resolve(trimResponse(joined)));
          return;
        }
        finish(() => reject(new Error('clamd socket closed')));
      };
      const onData = (chunk: Buffer) => {
        if (settled) return;
        chunks.push(chunk);
        total += chunk.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          finish(() => reject(new Error('clamd response too large')));
          return;
        }
        const joined = Buffer.concat(chunks, total);
        if (isTerminalResponse(joined)) {
          finish(() => resolve(trimResponse(joined)));
        }
      };

      socket.on('data', onData);
      socket.once('error', onError);
      socket.once('close', onClose);
    });
  }

  private clearSocket(): void {
    if (!this.socket) return;
    this.socket.off('close', this.socketDropHandler);
    this.socket.off('error', this.socketDropHandler);
    this.socket = null;
  }

  private resetSocket(): void {
    if (this.socket) {
      this.socket.off('close', this.socketDropHandler);
      this.socket.off('error', this.socketDropHandler);
      this.socket.destroy();
    }
    this.socket = null;
  }
}

export const __forTesting__ = {
  parseClamdResponse,
  chunkBytes,
  trimResponse,
};
