import { authenticate } from "@/lib/auth";
import { db } from "@/lib/db";
import { readJson, route } from "@/lib/http";
import { CreatePostBody, ListQuery, createPost, listPosts } from "@/lib/posts";

// pg needs the Node runtime (TCP sockets); Edge can't hold a Postgres connection.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (req) => {
  const ctx = await authenticate(req);
  const query = ListQuery.parse(Object.fromEntries(new URL(req.url).searchParams));
  return Response.json(await listPosts(db(), ctx, query));
});

export const POST = route(async (req) => {
  const ctx = await authenticate(req);
  const body = CreatePostBody.parse(await readJson(req));
  const post = await createPost(db(), ctx, body);
  return Response.json(post, { status: 201, headers: { location: `/api/v1/posts/${post.id}` } });
});
