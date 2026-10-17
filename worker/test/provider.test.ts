import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderClient } from "../src/provider.js";
import { startMock, type RunningMock } from "./support/mock-provider.js";

let mock: RunningMock | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

const client = (url: string, timeoutMs = 2000) => new ProviderClient({ baseUrl: url, timeoutMs, defaultRetryAfterSec: 30 });

describe("ProviderClient maps the contract to typed results", () => {
  it("200 -> published with external id", async () => {
    mock = await startMock();
    const r = await client(mock.url).publish(mock.at("pu_acme_ana"), "hola", "post-1");
    expect(r).toMatchObject({ kind: "published", status: 200 });
  });

  it("401 -> token_expired / token_revoked", async () => {
    mock = await startMock();
    const c = client(mock.url);
    expect((await c.publish(mock.at("pu_acme_carla"), "x", "p")).kind).toBe("token_expired");
    expect((await c.publish(mock.at("pu_globex_fede"), "x", "p")).kind).toBe("token_revoked");
    expect((await c.publish("unknown", "x", "p")).kind).toBe("token_revoked");
  });

  it("429 -> rate_limited with scope and Retry-After", async () => {
    mock = await startMock({ userRateLimit: { capacity: 1, refillPerSec: 0.1 } });
    const c = client(mock.url);
    await c.publish(mock.at("pu_acme_ana"), "x", "p1");
    expect(await c.publish(mock.at("pu_acme_ana"), "x", "p2")).toEqual({
      kind: "rate_limited",
      scope: "user",
      retryAfterSec: 10,
      status: 429,
    });
  });

  it("429 scope=app is distinguished from scope=user", async () => {
    mock = await startMock({ appRateLimit: { capacity: 1, refillPerSec: 0.5 } });
    const c = client(mock.url);
    await c.publish(mock.at("pu_acme_ana"), "x", "p1");
    expect(await c.publish(mock.at("pu_acme_bruno"), "x", "p2")).toMatchObject({ kind: "rate_limited", scope: "app" });
  });

  it("5xx -> server_error", async () => {
    mock = await startMock({ errorRate5xx: 1 });
    expect(await client(mock.url).publish(mock.at("pu_acme_ana"), "x", "p")).toMatchObject({ kind: "server_error" });
  });

  it("422 -> invalid_content", async () => {
    mock = await startMock();
    expect((await client(mock.url).publish(mock.at("pu_acme_ana"), "", "p")).kind).toBe("invalid_content");
  });

  it("refresh: rotated pair / invalid_grant / transient", async () => {
    mock = await startMock();
    const c = client(mock.url);
    expect(await c.refresh(mock.rt("pu_acme_carla"))).toMatchObject({ kind: "refreshed", expiresInSec: 600 });
    expect(await c.refresh(mock.rt("pu_globex_fede"))).toEqual({ kind: "invalid_grant", detail: "grant_revoked" });
    await mock.close();
    mock = await startMock({ errorRate5xx: 1 });
    expect((await client(mock.url).refresh(mock.rt("pu_acme_ana"))).kind).toBe("transient");
  });

  it("connection refused -> network_error not sent (safe to retry)", async () => {
    // Grab a free port and release it, so nothing is listening there.
    const srv = createServer();
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const { port } = srv.address() as AddressInfo;
    await new Promise((resolve) => srv.close(resolve));
    const r = await client(`http://127.0.0.1:${port}`).publish("t", "x", "p");
    expect(r).toMatchObject({ kind: "network_error", sent: false, detail: "ECONNREFUSED" });
  });

  it("timeout -> network_error that may have been sent (outcome unknown)", async () => {
    mock = await startMock({ latencyMaxMs: 3000, seed: 3 });
    // seed 3: first latency draw is well above the 50 ms timeout
    const r = await client(mock.url, 50).publish(mock.at("pu_acme_ana"), "x", "p");
    expect(r).toMatchObject({ kind: "network_error", sent: true });
  });
});
