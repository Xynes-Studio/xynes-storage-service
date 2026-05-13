/**
 * Service config — environment-driven, validated at startup.
 *
 * The plan (STORAGE-2/3) reserves these keys; defaults are dev-friendly.
 * Production deployments MUST set them explicitly.
 */
export interface ServiceConfig {
  readonly port: number;
  readonly internalServiceToken: string | null;
  readonly internalAuthMode: 'hybrid' | 'jwt';
  readonly multipartThresholdBytes: number;
  readonly maxJsonBodyBytes: number;
}

const DEFAULT_PORT = 4204; // STORAGE-1 reserved.
const DEFAULT_MULTIPART_THRESHOLD = 100 * 1024 * 1024; // 100 MB per AWS guidance.
const DEFAULT_MAX_JSON_BODY = 1024 * 1024; // 1 MB action envelope; objects themselves go direct to provider.

function readPort(env: NodeJS.ProcessEnv): number {
  const raw = env.PORT;
  if (!raw) return DEFAULT_PORT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    return DEFAULT_PORT;
  }
  return parsed;
}

function readMultipartThreshold(env: NodeJS.ProcessEnv): number {
  const raw = env.STORAGE_MULTIPART_THRESHOLD_BYTES;
  if (!raw) return DEFAULT_MULTIPART_THRESHOLD;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MULTIPART_THRESHOLD;
  return parsed;
}

function readMaxJsonBody(env: NodeJS.ProcessEnv): number {
  const raw = env.MAX_JSON_BODY_BYTES;
  if (!raw) return DEFAULT_MAX_JSON_BODY;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_JSON_BODY;
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const internalAuthMode: 'hybrid' | 'jwt' = env.INTERNAL_AUTH_MODE === 'jwt' ? 'jwt' : 'hybrid';
  return {
    port: readPort(env),
    internalServiceToken: env.INTERNAL_SERVICE_TOKEN ?? null,
    internalAuthMode,
    multipartThresholdBytes: readMultipartThreshold(env),
    maxJsonBodyBytes: readMaxJsonBody(env),
  };
}
