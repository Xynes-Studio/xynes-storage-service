/**
 * Cryptographically random request id used for log correlation.
 *
 * Defense-in-depth: when the gateway forwards `X-Request-Id` we honour it,
 * but the middleware also generates one server-side if absent.
 */
export function generateRequestId(): string {
  // 16 bytes = 22 base64url chars; plenty for log correlation, not used for security.
  return crypto.randomUUID();
}
