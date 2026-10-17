import { SignJWT } from "jose";

export const JWT_ISSUER = "ploot-dev";
export const JWT_AUDIENCE = "ploot-api";

/**
 * Test tokens without an IdP: HS256 signed with JWT_SECRET. Production would verify RS256/ES256
 * tokens from the IdP via JWKS; the claims contract (tenant_id + profile_id) stays the same.
 */
export async function signDevJwt(
  secret: string,
  claims: { tenantId: string; profileId: string },
  ttlSec = 7 * 24 * 3600,
): Promise<string> {
  if (secret.length < 32) throw new Error("JWT_SECRET must be at least 32 characters");
  return new SignJWT({ tenant_id: claims.tenantId, profile_id: claims.profileId })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(claims.profileId)
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlSec}s`)
    .sign(new TextEncoder().encode(secret));
}
