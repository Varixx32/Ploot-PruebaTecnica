import { describe, expect, it } from "vitest";
import { at, makeApp, publish } from "./helpers.js";

describe("/__admin", () => {
  it("requires X-Admin-Key when configured", async () => {
    const { app } = makeApp({ adminKey: "s3cret" });
    expect((await app.inject({ method: "GET", url: "/__admin/tokens" })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: "/__admin/tokens", headers: { "x-admin-key": "wrong!" } })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: "/__admin/tokens", headers: { "x-admin-key": "s3cret" } })).statusCode,
    ).toBe(200);
  });

  it("is not registered when disabled", async () => {
    const { app } = makeApp({ adminEnabled: false });
    expect((await app.inject({ method: "GET", url: "/__admin/tokens" })).statusCode).toBe(404);
  });

  it("revokes a user mid-flight: their valid token starts failing as revoked", async () => {
    const { app } = makeApp();
    expect((await publish(app, at("pu_acme_bruno"))).statusCode).toBe(200);
    await app.inject({ method: "POST", url: "/__admin/tokens/pu_acme_bruno/revoke" });
    expect((await publish(app, at("pu_acme_bruno"))).json().error).toBe("token_revoked");
    expect((await app.inject({ method: "POST", url: "/__admin/tokens/nobody/revoke" })).statusCode).toBe(404);
  });

  it("reset restores fixtures, empties the ledger and the buckets", async () => {
    const { app } = makeApp({ userRateLimit: { capacity: 1, refillPerSec: 0.001 } });
    await publish(app, at("pu_acme_ana"));
    expect((await publish(app, at("pu_acme_ana"))).statusCode).toBe(429);
    await app.inject({ method: "POST", url: "/__admin/tokens/pu_acme_ana/revoke" });

    await app.inject({ method: "POST", url: "/__admin/reset" });

    expect((await app.inject({ method: "GET", url: "/__admin/publishes" })).json().total).toBe(0);
    expect((await publish(app, at("pu_acme_ana"))).statusCode).toBe(200);
  });
});
