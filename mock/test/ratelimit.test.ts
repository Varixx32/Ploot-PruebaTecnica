import { describe, expect, it } from "vitest";
import { at, makeApp, publish } from "./helpers.js";

const generousApp = { capacity: 1000, refillPerSec: 1000 };

describe("provider rate limits", () => {
  it("per-user bucket: 429 with Retry-After once exhausted, other users unaffected", async () => {
    const { app } = makeApp({ userRateLimit: { capacity: 2, refillPerSec: 0.1 }, appRateLimit: generousApp });
    expect((await publish(app, at("pu_acme_ana"))).statusCode).toBe(200);
    expect((await publish(app, at("pu_acme_ana"))).statusCode).toBe(200);

    const limited = await publish(app, at("pu_acme_ana"));
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["x-ratelimit-scope"]).toBe("user");
    expect(limited.headers["retry-after"]).toBe("10");

    expect((await publish(app, at("pu_acme_bruno"))).statusCode).toBe(200);
  });

  it("waiting Retry-After seconds lets the user publish again", async () => {
    const { app, clock } = makeApp({ userRateLimit: { capacity: 1, refillPerSec: 0.5 }, appRateLimit: generousApp });
    await publish(app, at("pu_acme_ana"));
    const limited = await publish(app, at("pu_acme_ana"));
    clock.advance(Number(limited.headers["retry-after"]) * 1000);
    expect((await publish(app, at("pu_acme_ana"))).statusCode).toBe(200);
  });

  it("per-app bucket is shared across users and tenants", async () => {
    const { app } = makeApp({
      userRateLimit: { capacity: 10, refillPerSec: 1 },
      appRateLimit: { capacity: 3, refillPerSec: 0.25 },
    });
    expect((await publish(app, at("pu_acme_ana"))).statusCode).toBe(200);
    expect((await publish(app, at("pu_acme_bruno"))).statusCode).toBe(200);
    expect((await publish(app, at("pu_globex_diego"))).statusCode).toBe(200);

    const limited = await publish(app, at("pu_acme_ana"));
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["x-ratelimit-scope"]).toBe("app");
    expect(limited.headers["retry-after"]).toBe("4");
  });

  it("an app-scope 429 does not consume the user's own quota", async () => {
    const { app, clock } = makeApp({
      userRateLimit: { capacity: 2, refillPerSec: 0.001 },
      appRateLimit: { capacity: 1, refillPerSec: 1 },
    });
    expect((await publish(app, at("pu_acme_ana"))).statusCode).toBe(200);
    expect((await publish(app, at("pu_acme_ana"))).headers["x-ratelimit-scope"]).toBe("app");
    clock.advance(1000);
    expect((await publish(app, at("pu_acme_ana"))).statusCode).toBe(200);
  });

  it("ignoring Retry-After gets the account restricted (soft-ban), others keep working", async () => {
    const { app } = makeApp({
      userRateLimit: { capacity: 1, refillPerSec: 0.01 },
      appRateLimit: generousApp,
      abuse: { strikes: 3, windowSec: 60, restrictionSec: 300 },
    });
    await publish(app, at("pu_acme_ana"));
    for (let i = 0; i < 3; i++) expect((await publish(app, at("pu_acme_ana"))).statusCode).toBe(429);

    const banned = await publish(app, at("pu_acme_ana"));
    expect(banned.statusCode).toBe(403);
    expect(banned.json().error).toBe("account_restricted");
    expect(banned.headers["retry-after"]).toBe("300");

    expect((await publish(app, at("pu_acme_bruno"))).statusCode).toBe(200);
    const restrictions = (await app.inject({ method: "GET", url: "/__admin/restrictions" })).json();
    expect(restrictions.map((r: { provider_user_id: string }) => r.provider_user_id)).toEqual(["pu_acme_ana"]);
  });

  it("strikes outside the window do not accumulate; restriction lifts after its duration", async () => {
    const { app, clock } = makeApp({
      userRateLimit: { capacity: 1, refillPerSec: 0.001 },
      appRateLimit: generousApp,
      abuse: { strikes: 2, windowSec: 10, restrictionSec: 30 },
    });
    await publish(app, at("pu_acme_ana"));
    await publish(app, at("pu_acme_ana")); // strike 1
    clock.advance(11_000);
    expect((await publish(app, at("pu_acme_ana"))).statusCode).toBe(429); // strike 1 again, old one expired
    expect((await publish(app, at("pu_acme_ana"))).statusCode).toBe(429); // strike 2 -> restricted
    expect((await publish(app, at("pu_acme_ana"))).statusCode).toBe(403);
    clock.advance(30_000);
    expect((await publish(app, at("pu_acme_ana"))).statusCode).not.toBe(403);
  });
});
