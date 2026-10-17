import { describe, expect, it } from "vitest";
import { at, makeApp, publish } from "./helpers.js";

describe("POST /provider/publish", () => {
  it("publishes with a valid token and returns an external id", async () => {
    const { app } = makeApp();
    const res = await publish(app, at("pu_acme_ana"));
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toMatch(/^ext_[0-9a-f]{16}$/);
  });

  it.each([
    ["pu_acme_carla", "token_expired"],
    ["pu_globex_fede", "token_revoked"],
    [null, "invalid_token"],
  ])("rejects the token of %s with 401 %s", async (identity, error) => {
    const { app } = makeApp();
    const res = await publish(app, identity ? at(identity) : "not_a_token");
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe(error);
  });

  it("rejects a missing Authorization header", async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: "POST", url: "/provider/publish", payload: { text: "x" } });
    expect(res.statusCode).toBe(401);
  });

  it("rejects empty or oversized content with 422", async () => {
    const { app } = makeApp();
    expect((await publish(app, at("pu_acme_ana"), { text: "  " })).statusCode).toBe(422);
    expect((await publish(app, at("pu_acme_ana"), { text: "x".repeat(3001) })).statusCode).toBe(422);
  });

  it.each(["500", "502", "503"])("can be forced to return %s and does not publish", async (code) => {
    const { app } = makeApp();
    const res = await publish(app, at("pu_acme_ana"), { force: code, clientRef: "p1" });
    expect(res.statusCode).toBe(Number(code));
    const ledger = await app.inject({ method: "GET", url: "/__admin/publishes" });
    expect(ledger.json().total).toBe(0);
  });

  it("forced 429 carries Retry-After and scope", async () => {
    const { app } = makeApp({ forcedRetryAfterSec: 7 });
    const res = await publish(app, at("pu_acme_ana"), { force: "429" });
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBe("7");
    expect(res.headers["x-ratelimit-scope"]).toBe("user");
  });

  it("random 5xx rate is honoured and reproducible with the same seed", async () => {
    const run = async () => {
      const { app } = makeApp({
        errorRate5xx: 0.5,
        seed: 7,
        userRateLimit: { capacity: 1000, refillPerSec: 1 },
        appRateLimit: { capacity: 1000, refillPerSec: 1 },
      });
      const codes: number[] = [];
      for (let i = 0; i < 40; i++) codes.push((await publish(app, at("pu_acme_ana"))).statusCode);
      return codes;
    };
    const a = await run();
    expect(a).toEqual(await run());
    const failures = a.filter((c) => c >= 500).length;
    expect(failures).toBeGreaterThan(5);
    expect(failures).toBeLessThan(35);
  });

  it("records every publish so duplicates by client ref are observable", async () => {
    const { app } = makeApp();
    await publish(app, at("pu_acme_ana"), { clientRef: "post-1" });
    await publish(app, at("pu_acme_bruno"), { clientRef: "post-2" });
    await publish(app, at("pu_acme_bruno"), { clientRef: "post-2" });
    const body = (await app.inject({ method: "GET", url: "/__admin/publishes" })).json();
    expect(body.total).toBe(3);
    expect(body.duplicates).toEqual([{ client_ref: "post-2", count: 2 }]);
  });
});
