import { authenticate } from "@/lib/auth";
import { db } from "@/lib/db";
import { readJson, route } from "@/lib/http";
import { UpdatePostBody, cancelPost, getPost, parsePostId, updatePost } from "@/lib/posts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { id: string };

export const GET = route<Params>(async (req, { params }) => {
  const ctx = await authenticate(req);
  return Response.json(await getPost(db(), ctx, parsePostId((await params).id)));
});

/** Edit content/schedule. 409 if published or being published. */
export const PATCH = route<Params>(async (req, { params }) => {
  const ctx = await authenticate(req);
  const id = parsePostId((await params).id);
  const body = UpdatePostBody.parse(await readJson(req));
  return Response.json(await updatePost(db(), ctx, id, body));
});

/** Cancel (soft delete). 409 if published or being published. */
export const DELETE = route<Params>(async (req, { params }) => {
  const ctx = await authenticate(req);
  return Response.json(await cancelPost(db(), ctx, parsePostId((await params).id)));
});
