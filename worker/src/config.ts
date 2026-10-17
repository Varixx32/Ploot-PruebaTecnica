import { hostname } from "node:os";
import { randomBytes } from "node:crypto";

export interface WorkerConfig {
  workerId: string;
  databaseUrl: string;
  dbPoolMax: number;
  providerBaseUrl: string;
  tokenEncKeys: string;
  pollIntervalMs: number;
  /** Max posts claimed per tick by this replica. */
  claimBatch: number;
  /** Max provider calls in flight in this process. */
  localConcurrency: number;
  /** Max posts in `publishing` across all replicas (exact: enforced inside the claim tx). */
  globalMaxInFlight: number;
  /** Max posts in `publishing` per tenant, so one tenant cannot take every slot. */
  tenantMaxInFlight: number;
  /** Shared app budget, kept below the provider's app limit. */
  appRate: { capacity: number; refillPerSec: number };
  /** Minimum spacing between two publishes of the same Embajador (proactive pacing). */
  ambassadorMinIntervalSec: number;
  leaseSec: number;
  maxAttempts: number;
  backoff: { baseMs: number; maxMs: number };
  httpTimeoutMs: number;
  tokenRefreshSkewSec: number;
  /** Used when a 429/403 comes without a usable Retry-After. */
  defaultRetryAfterSec: number;
  /** /healthz and /metrics. 0 disables the server. */
  httpPort: number;
}

function num(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Invalid number in env ${key}=${raw}`);
  return n;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`Missing env ${key}`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const config: WorkerConfig = {
    workerId: env.WORKER_ID || `${hostname()}-${process.pid}-${randomBytes(3).toString("hex")}`,
    databaseUrl: required(env, "DATABASE_URL"),
    dbPoolMax: num(env, "WORKER_DB_POOL_MAX", 5),
    providerBaseUrl: required(env, "PROVIDER_BASE_URL").replace(/\/+$/, ""),
    tokenEncKeys: required(env, "TOKEN_ENC_KEYS"),
    pollIntervalMs: num(env, "WORKER_POLL_INTERVAL_MS", 500),
    claimBatch: num(env, "WORKER_CLAIM_BATCH", 10),
    localConcurrency: num(env, "WORKER_LOCAL_CONCURRENCY", 8),
    globalMaxInFlight: num(env, "WORKER_GLOBAL_MAX_IN_FLIGHT", 20),
    tenantMaxInFlight: num(env, "WORKER_TENANT_MAX_IN_FLIGHT", 5),
    appRate: {
      capacity: num(env, "WORKER_APP_RATE_CAPACITY", 10),
      refillPerSec: num(env, "WORKER_APP_RATE_REFILL_PER_SEC", 1.5),
    },
    ambassadorMinIntervalSec: num(env, "WORKER_AMBASSADOR_MIN_INTERVAL_SEC", 25),
    leaseSec: num(env, "WORKER_LEASE_SEC", 60),
    maxAttempts: num(env, "WORKER_MAX_ATTEMPTS", 5),
    backoff: {
      baseMs: num(env, "WORKER_BACKOFF_BASE_MS", 2000),
      maxMs: num(env, "WORKER_BACKOFF_MAX_MS", 5 * 60 * 1000),
    },
    httpTimeoutMs: num(env, "WORKER_HTTP_TIMEOUT_MS", 8000),
    tokenRefreshSkewSec: num(env, "WORKER_TOKEN_REFRESH_SKEW_SEC", 60),
    defaultRetryAfterSec: num(env, "WORKER_DEFAULT_RETRY_AFTER_SEC", 30),
    // PaaS health checks hit $PORT; WORKER_HTTP_PORT wins when both are set.
    httpPort: num(env, "WORKER_HTTP_PORT", num(env, "PORT", 9464)),
  };

  // The lease must outlive the slowest possible processing (refresh + publish), or a healthy
  // worker would lose its post to the reaper.
  const worstCaseMs = 2 * config.httpTimeoutMs + 1000;
  if (config.leaseSec * 1000 <= worstCaseMs) {
    throw new Error(`WORKER_LEASE_SEC must exceed ${Math.ceil(worstCaseMs / 1000)}s (refresh + publish timeouts + margin)`);
  }
  return config;
}
