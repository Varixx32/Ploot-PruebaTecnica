import { describe, expect, it } from "vitest";
import { at, makeApp, publish, refresh, rt } from "./helpers.js";

describe("POST /provider/oauth/refresh", () => {
  it("refreshes an expired token and the new access token publishes", async () => {
    const { app } = makeApp({ accessTokenTtlSec: 600 });
    expect((await publish(app, at("pu_acme_carla"))).json().error).toBe("token_expired");

    const res = await refresh(app, rt("pu_acme_carla"));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ token_type: "Bearer", expires_in: 600 });

    expect((await publish(app, body.access_token)).statusCode).toBe(200);
  });

  it("issued access tokens expire after their TTL", async () => {
    const { app, clock } = makeApp({ accessTokenTtlSec: 60 });
    const { access_token } = (await refresh(app, rt("pu_acme_ana"))).json();
    clock.advance(60_000);
    expect((await publish(app, access_token)).json().error).toBe("token_expired");
  });

  it("rotates: the old refresh token is rejected as reused, the old access token stops working", async () => {
    const { app } = makeApp();
    expect((await refresh(app, rt("pu_acme_ana"))).statusCode).toBe(200);

    const reused = await refresh(app, rt("pu_acme_ana"));
    expect(reused.statusCode).toBe(400);
    expect(reused.json()).toEqual({ error: "invalid_grant", error_description: "refresh_token_reused" });
    expect((await publish(app, at("pu_acme_ana"))).json().error).toBe("invalid_token");
  });

  it("a revoked grant cannot be refreshed", async () => {
    const { app } = makeApp();
    const res = await refresh(app, rt("pu_globex_fede"));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_grant", error_description: "grant_revoked" });
  });

  it("a transient 5xx on refresh does not consume the refresh token", async () => {
    const { app } = makeApp();
    expect((await refresh(app, rt("pu_acme_carla"), "503")).statusCode).toBe(503);
    expect((await refresh(app, rt("pu_acme_carla"))).statusCode).toBe(200);
  });

  it("requires a refresh_token", async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: "POST", url: "/provider/oauth/refresh", payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
  });
});
