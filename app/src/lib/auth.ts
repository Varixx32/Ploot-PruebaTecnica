import { jwtVerify } from "jose";
import { z } from "zod";
import type { TenantContext } from "@ploot/db";
import { env } from "./env";
import { ApiError } from "./http";

const ISSUER = "ploot-dev";
const AUDIENCE = "ploot-api";

const Claims = z.object({ tenant_id: z.uuid(), profile_id: z.uuid() });

/**
 * Verifies the Bearer JWT and returns the tenant context. The handler never uses tenant_id to
 * filter anything: it only becomes the RLS context of the transaction (see withTenant).
 */
export async function authenticate(req: Request): Promise<TenantContext> {
  const header = req.headers.get("authorization");
  const token = header?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) throw new ApiError(401, "unauthenticated", "Missing bearer token");

  let payload: unknown;
  try {
    ({ payload } = await jwtVerify(token, new TextEncoder().encode(env().jwtSecret()), {
      algorithms: ["HS256"],
      issuer: ISSUER,
      audience: AUDIENCE,
    }));
  } catch {
    throw new ApiError(401, "invalid_token", "Invalid or expired token");
  }
  const claims = Claims.safeParse(payload);
  if (!claims.success) throw new ApiError(401, "invalid_token", "Token lacks tenant_id/profile_id");
  return { tenantId: claims.data.tenant_id, profileId: claims.data.profile_id };
}
