import { randomBytes } from "node:crypto";
import { deriveInitialTokens } from "@ploot/provider-fixtures";
import { buildApp, type MockDeps } from "../src/app.js";
import { loadConfig, type MockConfig } from "../src/config.js";
import { createRng } from "../src/rng.js";

export interface FakeClock {
  now: () => number;
  advance: (ms: number) => void;
}

export function fakeClock(start = Date.UTC(2026, 9, 17, 9, 0, 0)): FakeClock {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

/** Fresh random secret per test run: no fixture token is ever written down. */
const FIXTURE_SECRET = randomBytes(32).toString("hex");

/** Initial access token of a fixture identity, e.g. at("pu_acme_ana"). */
export const at = (providerUserId: string) => deriveInitialTokens(FIXTURE_SECRET, providerUserId).accessToken;
/** Initial refresh token of a fixture identity. */
export const rt = (providerUserId: string) => deriveInitialTokens(FIXTURE_SECRET, providerUserId).refreshToken;

/** Deterministic app: no latency, no random 5xx, fake clock. Override per test. */
export function makeApp(overrides: Partial<MockConfig> = {}) {
  const clock = fakeClock();
  const config: MockConfig = {
    ...loadConfig({ MOCK_FIXTURE_SECRET: FIXTURE_SECRET }),
    latencyMaxMs: 0,
    errorRate5xx: 0,
    seed: 42,
    adminKey: undefined,
    ...overrides,
  };
  const deps: MockDeps = { now: clock.now, rng: createRng(config.seed), sleep: async () => {} };
  return { app: buildApp(config, deps), clock, config };
}

export function publish(
  app: ReturnType<typeof buildApp>,
  token: string,
  opts: { text?: string; clientRef?: string; force?: string } = {},
) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (opts.clientRef) headers["x-client-ref"] = opts.clientRef;
  if (opts.force) headers["x-mock-force"] = opts.force;
  return app.inject({ method: "POST", url: "/provider/publish", headers, payload: { text: opts.text ?? "hola" } });
}

export function refresh(app: ReturnType<typeof buildApp>, refreshToken: string, force?: string) {
  return app.inject({
    method: "POST",
    url: "/provider/oauth/refresh",
    headers: force ? { "x-mock-force": force } : {},
    payload: { refresh_token: refreshToken },
  });
}
