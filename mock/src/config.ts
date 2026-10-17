export interface MockConfig {
  port: number;
  host: string;
  /** Upper bound of the uniform random latency added to provider calls (0–N ms). */
  latencyMaxMs: number;
  /** Probability [0,1] that a publish returns a random 5xx. */
  errorRate5xx: number;
  /** Seed for the PRNG. Same seed => same sequence of latencies/failures. */
  seed: number;
  /** Lifetime of access tokens issued by /oauth/refresh. Short on purpose to exercise refresh. */
  accessTokenTtlSec: number;
  /** Per-user (per-Embajador) token bucket. */
  userRateLimit: { capacity: number; refillPerSec: number };
  /** Per-app bucket shared by every Embajador of every tenant. */
  appRateLimit: { capacity: number; refillPerSec: number };
  /** Soft-ban simulation for callers that ignore Retry-After. */
  abuse: { strikes: number; windowSec: number; restrictionSec: number };
  /** Retry-After sent when a 429 is forced via X-Mock-Force. */
  forcedRetryAfterSec: number;
  /** Exposes /__admin/* (inspection, revoke, reset). Never enable on an internet-facing mock without a key. */
  adminEnabled: boolean;
  /** If set, /__admin/* requires `X-Admin-Key: <value>`. */
  adminKey: string | undefined;
  /** Secret the initial fixture tokens are derived from (shared with the DB seed, env only). */
  fixtureSecret: string;
}

function num(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Invalid number in env ${key}=${raw}`);
  return n;
}

function bool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MockConfig {
  const config: MockConfig = {
    // PaaS (Railway, Render...) inject PORT; MOCK_PORT wins when both are set.
    port: num(env, "MOCK_PORT", num(env, "PORT", 4000)),
    host: env.MOCK_HOST ?? "0.0.0.0",
    latencyMaxMs: num(env, "MOCK_LATENCY_MAX_MS", 3000),
    errorRate5xx: num(env, "MOCK_5XX_RATE", 0.1),
    seed: num(env, "MOCK_SEED", Date.now() & 0x7fffffff),
    accessTokenTtlSec: num(env, "MOCK_ACCESS_TOKEN_TTL_SEC", 600),
    userRateLimit: {
      capacity: num(env, "MOCK_USER_RL_CAPACITY", 3),
      refillPerSec: num(env, "MOCK_USER_RL_REFILL_PER_SEC", 1 / 20),
    },
    appRateLimit: {
      capacity: num(env, "MOCK_APP_RL_CAPACITY", 20),
      refillPerSec: num(env, "MOCK_APP_RL_REFILL_PER_SEC", 2),
    },
    abuse: {
      strikes: num(env, "MOCK_ABUSE_STRIKES", 5),
      windowSec: num(env, "MOCK_ABUSE_WINDOW_SEC", 60),
      restrictionSec: num(env, "MOCK_ABUSE_RESTRICTION_SEC", 300),
    },
    forcedRetryAfterSec: num(env, "MOCK_FORCED_RETRY_AFTER_SEC", 5),
    adminEnabled: bool(env, "MOCK_ADMIN_ENABLED", true),
    adminKey: env.MOCK_ADMIN_KEY || undefined,
    fixtureSecret: env.MOCK_FIXTURE_SECRET ?? "",
  };

  if (config.fixtureSecret.length < 32) {
    throw new Error("MOCK_FIXTURE_SECRET is required (>= 32 chars)");
  }
  if (config.errorRate5xx < 0 || config.errorRate5xx > 1) {
    throw new Error("MOCK_5XX_RATE must be within [0,1]");
  }
  return config;
}
