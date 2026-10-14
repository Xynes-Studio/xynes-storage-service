/** Planned deploy control only: no job reclaim, provider replay or forced stop. */
import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import {
  chmodSync,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  constants,
} from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

export const CONTROL_SOCKET = '/run/xynes/storage-control/control.sock';
export const CONTROL_TOKEN = '/run/secrets/storage-quiesce-token';
interface Poller {
  start(intervalMs: number): void;
  stop(): void;
  drain(): Promise<void>;
}
interface Dependencies {
  worker: Poller;
  cleanup: Poller;
  workerIntervalMs: number;
  cleanupIntervalMs: number;
}
type State =
  'open' | 'draining' | 'quiesced' | 'timeout' | 'cancelled' | 'failed' | 'busy' | 'shutdown';
function require(value: unknown): asserts value {
  if (!value) throw new Error('Storage control refused');
}
function validOwner(owner: string) {
  return typeof owner === 'string' && /^[a-f0-9]{32}$/.test(owner);
}

export class Quiescence {
  private owner: string | null = null;
  private expiresAt = 0;
  private lease: ReturnType<typeof setTimeout> | null = null;
  private epoch = 0;
  private state: State = 'open';
  private readonly http = new Set<Promise<Response>>();
  private background = 0;
  private draining: Promise<boolean> | null = null;
  constructor(private readonly deps: Dependencies) {}

  wrap(fetch: (request: Request) => Response | Promise<Response>) {
    return (request: Request): Promise<Response> => {
      if (this.state !== 'open') {
        // Static liveness remains available without admitting an app handler.
        return Promise.resolve(
          new Response(
            new URL(request.url).pathname === '/health' ? 'ok' : 'Storage temporarily quiescing',
            { status: new URL(request.url).pathname === '/health' ? 200 : 503 },
          ),
        );
      }
      const pass = Promise.resolve().then(() => fetch(request));
      this.http.add(pass);
      void pass.finally(() => this.http.delete(pass)).catch(() => {});
      return pass;
    };
  }
  startPolling(): void {
    if (this.state !== 'open') return;
    this.deps.worker.start(this.deps.workerIntervalMs);
    this.deps.cleanup.start(this.deps.cleanupIntervalMs);
  }
  status(owner: string) {
    require(validOwner(owner) && (this.owner === null || this.owner === owner));
    return {
      state: this.state,
      owner: this.owner,
      expires_at: this.expiresAt || null,
      admission_open: this.state === 'open',
      active_http: this.http.size,
      active_background: this.background,
    };
  }
  async quiesce(owner: string, timeoutMs: number, leaseMs: number, signal?: AbortSignal) {
    require(
      validOwner(owner) &&
        Number.isSafeInteger(timeoutMs) &&
        timeoutMs >= 1 &&
        timeoutMs <= 120000 &&
        Number.isSafeInteger(leaseMs) &&
        leaseMs >= 1000 &&
        leaseMs <= 3600000 &&
        timeoutMs < leaseMs,
    );
    if (this.state === 'shutdown' || (this.owner !== null && this.owner !== owner)) {
      return { state: 'busy' as const, owner };
    }
    if (this.owner === null) {
      this.owner = owner;
      this.state = 'draining';
      this.epoch++;
      this.deps.worker.stop();
      this.deps.cleanup.stop();
      const epoch = this.epoch;
      this.background = 2;
      const background = [this.deps.worker, this.deps.cleanup].map((poller) =>
        Promise.resolve()
          .then(() => {
            if (epoch !== this.epoch || this.owner !== owner) return;
            return poller.drain();
          })
          .finally(() => {
            if (epoch === this.epoch) this.background--;
          }),
      );
      this.draining = Promise.allSettled([...this.http, ...background]).then((results) =>
        results.every((result) => result.status === 'fulfilled'),
      );
    }
    if (this.lease) clearTimeout(this.lease);
    this.expiresAt = Date.now() + leaseMs;
    this.lease = setTimeout(() => {
      if (this.owner === owner && this.state !== 'shutdown') this.resume(owner);
    }, leaseMs);
    const epoch = this.epoch;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    const interrupt = new Promise<State>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
      cancel = () => resolve('cancelled');
      if (signal?.aborted) cancel();
      else signal?.addEventListener('abort', cancel, { once: true });
    });
    try {
      const outcome = await Promise.race([
        this.draining!.then((ok) => (ok ? ('quiesced' as const) : ('failed' as const))),
        interrupt,
      ]);
      if (epoch !== this.epoch || this.owner !== owner)
        return { state: 'cancelled' as const, owner };
      this.state = outcome;
      return this.status(owner);
    } finally {
      if (timer) clearTimeout(timer);
      if (cancel) signal?.removeEventListener('abort', cancel);
    }
  }
  resume(owner: string): boolean {
    require(validOwner(owner));
    if (this.owner !== owner || this.state === 'shutdown') return false;
    if (this.lease) clearTimeout(this.lease);
    this.lease = null;
    this.owner = null;
    this.expiresAt = 0;
    this.epoch++;
    this.draining = null;
    this.background = 0;
    this.state = 'open';
    this.startPolling();
    return true;
  }
  /** Synchronous one-use proof: expiry/resume can never reopen during teardown. */
  consumeProof(): boolean {
    if (
      this.state !== 'quiesced' ||
      this.expiresAt <= Date.now() ||
      this.http.size !== 0 ||
      this.background !== 0
    )
      return false;
    this.state = 'shutdown';
    this.epoch++;
    if (this.lease) clearTimeout(this.lease);
    this.lease = null;
    this.deps.worker.stop();
    this.deps.cleanup.stop();
    return true;
  }
}

export function readControlToken(path = CONTROL_TOKEN): string {
  require(isAbsolute(path) && realpathSync(path) === path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    require(
      info.isFile() &&
        info.nlink === 1 &&
        (info.uid === 0 || info.uid === process.getuid?.()) &&
        [0o400, 0o600].includes(info.mode & 0o777) &&
        info.size >= 64 &&
        info.size <= 65,
    );
    const buffer = Buffer.alloc(66);
    let size = 0;
    while (size < buffer.length) {
      const next = readSync(fd, buffer, size, buffer.length - size, null);
      if (!next) break;
      size += next;
    }
    require(size === info.size && size <= 65);
    const value = buffer.subarray(0, size).toString('utf8');
    const after = fstatSync(fd);
    const leaf = lstatSync(path);
    require(
      info.dev === leaf.dev &&
        info.ino === leaf.ino &&
        info.size === after.size &&
        info.mtimeMs === after.mtimeMs &&
        info.mode === after.mode &&
        info.nlink === after.nlink &&
        info.ctimeMs === after.ctimeMs &&
        info.ctimeMs === leaf.ctimeMs &&
        /^[a-f0-9]{64}\n?$/.test(value),
    );
    return value.trim();
  } finally {
    closeSync(fd);
  }
}

/** Unix HTTP only. Optional arguments are trusted private-fixture boundaries. */
export async function startPrivateControl(
  gate: Quiescence,
  options: { unix?: string; token?: string } = {},
) {
  const unix = options.unix ?? CONTROL_SOCKET;
  const token = options.token ?? readControlToken();
  require(
    isAbsolute(unix) &&
      realpathSync(dirname(unix)) === dirname(unix) &&
      /^[a-f0-9]{64}$/.test(token),
  );
  const parent = lstatSync(dirname(unix));
  require(
    parent.isDirectory() && parent.uid === process.getuid?.() && (parent.mode & 0o777) === 0o700,
  );
  try {
    lstatSync(unix);
    throw new Error('Storage control refused');
  } catch (error) {
    require((error as NodeJS.ErrnoException).code === 'ENOENT');
  }
  const server = createServer(
    { maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 5000 },
    async (req, res) => {
      const reply = (status: number, value: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' });
        res.end(JSON.stringify(value));
      };
      try {
        const credential = req.headers.authorization;
        if (
          typeof credential !== 'string' ||
          !/^Bearer [a-f0-9]{64}$/.test(credential) ||
          !timingSafeEqual(Buffer.from(credential.slice(7)), Buffer.from(token))
        ) {
          reply(403, { error: 'Control refused' });
          return;
        }
        require(
          req.method === 'POST' &&
            ['/quiesce', '/resume', '/status'].includes(req.url ?? '') &&
            req.headers['content-type'] === 'application/json' &&
            req.headers['transfer-encoding'] === undefined &&
            /^\d{1,4}$/.test(req.headers['content-length'] ?? '') &&
            Number(req.headers['content-length']) <= 1024,
        );
        let raw = '';
        req.setEncoding('utf8');
        for await (const chunk of req) {
          raw += String(chunk);
          require(Buffer.byteLength(raw) <= 1024);
        }
        const body = JSON.parse(raw) as Record<string, unknown>;
        require(
          raw === JSON.stringify(body) &&
            typeof body === 'object' &&
            body !== null &&
            !Array.isArray(body) &&
            validOwner(body.owner as string),
        );
        if (req.url === '/quiesce') {
          require(Object.keys(body).sort().join(',') === 'lease_ms,owner,timeout_ms');
          const abort = new AbortController();
          const disconnected = () => {
            if (!res.writableEnded) abort.abort();
          };
          res.once('close', disconnected);
          try {
            reply(
              200,
              await gate.quiesce(
                body.owner as string,
                body.timeout_ms as number,
                body.lease_ms as number,
                abort.signal,
              ),
            );
          } finally {
            res.off('close', disconnected);
          }
        } else {
          require(Object.keys(body).join(',') === 'owner');
          if (req.url === '/resume') {
            const resumed = gate.resume(body.owner as string);
            reply(resumed ? 200 : 409, { resumed });
          } else reply(200, gate.status(body.owner as string));
        }
      } catch {
        if (!res.headersSent) reply(400, { error: 'Control refused' });
        else res.destroy();
      }
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(unix, () => {
      server.off('error', reject);
      resolve();
    });
  });
  chmodSync(unix, 0o600);
  const owned = lstatSync(unix);
  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Node may unlink its Unix path while closing. Check ownership before
        // invoking it; a substituted foreign path must remain untouched.
        try {
          const current = lstatSync(unix);
          require(
            current.isSocket() &&
              current.dev === owned.dev &&
              current.ino === owned.ino &&
              current.uid === owned.uid &&
              (current.mode & 0o777) === 0o600,
          );
        } catch {
          reject(new Error('Storage control refused'));
          return;
        }
        server.close((error) => {
          try {
            // Node normally removes its own Unix socket. Never remove a replacement.
            try {
              const current = lstatSync(unix);
              if (current.dev === owned.dev && current.ino === owned.ino) unlinkSync(unix);
            } catch (missing) {
              require((missing as NodeJS.ErrnoException).code === 'ENOENT');
            }
            if (error) reject(new Error('Storage control refused'));
            else resolve();
          } catch {
            reject(new Error('Storage control refused'));
          }
        });
      }),
  };
}
