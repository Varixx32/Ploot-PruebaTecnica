import { SignJWT } from "jose";
import { env } from "./env";

/**
 * Demo-only identities: the seeded tenants/profiles (fixed seed ids, not secrets). Kept in sync
 * with packages/db/src/dev/seed.ts by test/demo.test.ts.
 */
export const DEMO_PROFILES = {
  acme: { tenantId: "11111111-1111-4111-8111-111111111111", profileId: "a1000000-0000-4000-8000-000000000001", name: "Ana" },
  globex: { tenantId: "22222222-2222-4222-8222-222222222222", profileId: "a2000000-0000-4000-8000-000000000004", name: "Diego" },
} as const;

export type DemoTenant = keyof typeof DEMO_PROFILES;

/** Short-lived token for the demo UI, same claims contract as any other caller. */
export function signDemoToken(tenant: DemoTenant): Promise<string> {
  const p = DEMO_PROFILES[tenant];
  return new SignJWT({ tenant_id: p.tenantId, profile_id: p.profileId })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(p.profileId)
    .setIssuer("ploot-dev")
    .setAudience("ploot-api")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(env().jwtSecret()));
}
