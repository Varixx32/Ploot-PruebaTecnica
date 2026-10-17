import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { deriveInitialTokens } from "@ploot/provider-fixtures";
import { buildApp } from "../../../mock/src/app.js";
import { loadConfig, type MockConfig } from "../../../mock/src/config.js";

export interface RunningMock {
  url: string;
  fixtureSecret: string;
  adminKey: string;
  at: (providerUserId: string) => string;
  rt: (providerUserId: string) => string;
  admin: <T = unknown>(path: string, method?: "GET" | "POST") => Promise<T>;
  close: () => Promise<void>;
}

/** Real mock provider over real HTTP on a random port, with throwaway secrets. */
export async function startMock(overrides: Partial<MockConfig> = {}): Promise<RunningMock> {
  const fixtureSecret = randomBytes(32).toString("hex");
  const adminKey = randomBytes(16).toString("hex");
  const config: MockConfig = {
    ...loadConfig({ MOCK_FIXTURE_SECRET: fixtureSecret }),
    latencyMaxMs: 0,
    errorRate5xx: 0,
    seed: 1,
    adminKey,
    ...overrides,
  };
  const app = buildApp(config);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  return {
    url,
    fixtureSecret,
    adminKey,
    at: (u) => deriveInitialTokens(fixtureSecret, u).accessToken,
    rt: (u) => deriveInitialTokens(fixtureSecret, u).refreshToken,
    admin: async (path, method = "GET") => {
      const res = await fetch(`${url}/__admin${path}`, { method, headers: { "x-admin-key": adminKey } });
      return res.json();
    },
    close: () => app.close(),
  };
}
