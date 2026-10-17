import { authenticate } from "@/lib/auth";
import { db } from "@/lib/db";
import { route } from "@/lib/http";
import { parseIdempotencyKey, withIdempotency } from "@/lib/idempotency";
import { parsePostId, publishNowTx } from "@/lib/posts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Publish now (202: queued at the head, the worker publishes it). Requires Idempotency-Key. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await authenticate(req);
  const key = parseIdempotencyKey(req);
  const id = parsePostId((await params).id);
  const res = await withIdempotency(db(), ctx, key, `POST /api/v1/posts/${id}/publish`, id, async (tx) => {
    const { status, post } = await publishNowTx(tx, id);
    return { status, body: post };
  });
  return Response.json(res.body, {
    status: res.status,
    headers: res.replayed ? { "idempotent-replayed": "true" } : {},
  });
});
