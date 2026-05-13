/**
 * Minimal structured logger.
 *
 * STORAGE-9 will add redaction rules. For now we emit a single JSON line
 * per log call so log aggregators can ingest cleanly. Field-name redaction
 * for the forbidden-field families (see DEVELOPER.md → "Forbidden fields")
 * is enforced by callers — no field listed there should ever be passed to
 * this logger.
 */
type LogLevel = 'info' | 'warn' | 'error' | 'debug';

function emit(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    service: 'storage-service',
    message,
    ...(fields ?? {}),
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
