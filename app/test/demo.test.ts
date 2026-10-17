import { describe, expect, it } from "vitest";
import { DEMO_PROFILES } from "../src/lib/demo";
import { SEED_AMBASSADORS, SEED_TENANTS } from "../../packages/db/src/dev/seed.js";
import * as login from "../src/app/api/demo/login/route";
import { authenticate } from "../src/lib/auth";

describe("demo login", () => {
  it("demo profiles match the seed", () => {
    for (const [tenant, p] of Object.entries(DEMO_PROFILES)) {
      expect(SEED_TENANTS[tenant as keyof typeof SEED_TENANTS]).toBe(p.tenantId);
      expect(SEED_AMBASSADORS.find((a) => a.id === p.profileId)?.name).toBe(p.name);
    }
  });

  it("is disabled unless DEMO_LOGIN_ENABLED=true, and issues verifiable tokens when enabled", async () => {
    process.env.JWT_SECRET = "t".repeat(40);
    const req = () => new Request("http://x/api/demo/login", { method: "POST", body: JSON.stringify({ tenant: "acme" }) });
    process.env.DEMO_LOGIN_ENABLED = "false";
    expect((await login.POST(req(), { params: Promise.resolve({}) })).status).toBe(404);

    process.env.DEMO_LOGIN_ENABLED = "true";
    const res = await login.POST(req(), { params: Promise.resolve({}) });
    const { token } = await res.json();
    const ctx = await authenticate(new Request("http://x", { headers: { authorization: `Bearer ${token}` } }));
    expect(ctx).toEqual({ tenantId: DEMO_PROFILES.acme.tenantId, profileId: DEMO_PROFILES.acme.profileId });
  });
});
