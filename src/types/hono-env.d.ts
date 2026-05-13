/**
 * Hono context variables typed once for the whole service.
 */
import 'hono';

declare module 'hono' {
  interface ContextVariableMap {
    requestId: string;
  }
}
