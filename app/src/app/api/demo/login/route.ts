import { z } from "zod";
import { DEMO_PROFILES, signDemoToken } from "@/lib/demo";
import { env } from "@/lib/env";
import { ApiError, readJson, route } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ tenant: z.enum(["acme", "globex"]) });

/** Demo convenience: a 1 h JWT for a seeded profile. Disabled unless DEMO_LOGIN_ENABLED=true. */
export const POST = route(async (req) => {
  if (!env().demoLoginEnabled) throw new ApiError(404, "not_found", "Not found");
  const { tenant } = Body.parse(await readJson(req));
  return Response.json({ token: await signDemoToken(tenant), profile: DEMO_PROFILES[tenant] });
});
