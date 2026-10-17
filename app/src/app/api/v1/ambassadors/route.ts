import { authenticate } from "@/lib/auth";
import { db } from "@/lib/db";
import { route } from "@/lib/http";
import { listAmbassadors } from "@/lib/posts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Embajadores of the caller's tenant with their queue status (backlog, throttle, last outcome). */
export const GET = route(async (req) => {
  const ctx = await authenticate(req);
  return Response.json({ data: await listAmbassadors(db(), ctx) });
});
