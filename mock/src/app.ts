import Fastify, { type FastifyInstance } from "fastify";
import type { MockConfig } from "./config.js";
import { createRng, type Rng } from "./rng.js";
import { PublishLedger } from "./ledger.js";
import { RateLimiter } from "./ratelimit.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerOAuthRoutes } from "./routes/oauth.js";
import { registerPublishRoutes } from "./routes/publish.js";
import { TokenRegistry } from "./tokens.js";

export interface MockDeps {
  /** Current time in ms. Injected so rate limits and expiry are testable without sleeping. */
  now: () => number;
  rng: Rng;
  /** Artificial latency. Tests replace it with a no-op. */
  sleep: (ms: number) => Promise<void>;
}

export function defaultDeps(config: MockConfig): MockDeps {
  return {
    now: () => Date.now(),
    rng: createRng(config.seed),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

export function buildApp(
  config: MockConfig,
  deps: MockDeps = defaultDeps(config),
  tokens: TokenRegistry = TokenRegistry.fromSecret(config.fixtureSecret, config.accessTokenTtlSec, deps.now),
  ledger: PublishLedger = new PublishLedger(deps.now),
  limiter: RateLimiter = new RateLimiter(config.userRateLimit, config.appRateLimit, config.abuse, deps.now),
): FastifyInstance {
  const app = Fastify({
    logger: process.env.NODE_ENV === "test" ? false : { level: process.env.LOG_LEVEL ?? "info" },
  });

  app.get("/health", async () => ({ status: "ok" }));
  registerOAuthRoutes(app, config, deps, tokens);
  registerPublishRoutes(app, config, deps, tokens, ledger, limiter);
  registerAdminRoutes(app, config, tokens, ledger, limiter);

  return app;
}
