/**
 * Minimal structured logger.
 *
 * STORAGE-9: every log call routes through the storage-service-side
 * redaction mirror (`./redaction.ts`) BEFORE the JSON line is emitted.
 * The redactor scrubs:
 *
 *   - Sensitive field names (loose: `authorization`, `cookie`, `token`,
 *     `secret`, `x-amz-signature`, etc.; anchored: `apiKey`, `accessKeyId`,
 *     `secretAccessKey`, `credentialRef`, `r2Token`, etc.; compound:
 *     `*apikey*` modulo the `Id`/`Prefix` safelist).
 *   - Sensitive free-text patterns (raw `xynes_live_<hex>` API keys,
 *     Argon2 hashes, `Bearer <token>` headers, quoted x-xs-api-key /
 *     authorization header lines, SigV4 presigned URL signature query
 *     parameters).
 *
 * Callers are NOT relieved of their own responsibility — handlers should
 * never knowingly pass a raw `secretAccessKey` here — but the redactor is
 * the safety net so a future caller mistake cannot leak credentials
 * into stored logs.
 *
 * See: xynes-infra/docs/plans/2026-05-10-universal-object-storage-file-upload-api.md
 *      (STORAGE-9 § "Security, privacy, and abuse controls")
 */
import { redactLogFields, redactLogMessage } from './redaction';

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

function emit(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    service: 'storage-service',
    message: redactLogMessage(message),
    ...(redactLogFields(fields) ?? {}),
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(entry));
}

export const logger = {
  info: (message: string, fields?: Record<string, unknown>) => emit('info', message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => emit('warn', message, fields),
  error: (message: string, fields?: Record<string, unknown>) => emit('error', message, fields),
  debug: (message: string, fields?: Record<string, unknown>) => emit('debug', message, fields),
};
