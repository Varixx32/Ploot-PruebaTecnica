import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as postsRoute from "../src/app/api/v1/posts/route";
import * as postRoute from "../src/app/api/v1/posts/[id]/route";
import * as publishRoute from "../src/app/api/v1/posts/[id]/publish/route";
import * as ambassadorsRoute from "../src/app/api/v1/ambassadors/route";
import { zonedLocalToUtc } from "../src/lib/time";
import { SEED_AMBASSADORS, SEED_TENANTS, call, seedUuid, setupApiEnv, type ApiTestEnv } from "./support/setup";

let env: ApiTestEnv;
let ana: string; // acme
let bruno: string; // acme
let diego: string; // globex

beforeAll(async () => {
  env = await setupApiEnv();
  [ana, bruno, diego] = await Promise.all([env.token("acme", "Ana"), env.token("acme", "Bruno"), env.token("globex", "Diego")]);
});
afterAll(() => env.close());

const ACME_POST = seedUuid("ana-soon");
const amb = (name: string) => SEED_AMBASSADORS.find((a) => a.name === name)!.id;

/** Tomorrow at 09:00 in Madrid, as a local wall-clock string. */
function tomorrowAt9Madrid(): string {
  const d = new Date(Date.now() + 24 * 3600 * 1000);
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(d);
  return `${ymd}T09:00`;
}

async function createScheduled(token: string, extra: Record<string, unknown> = {}) {
  return call(postsRoute.POST, {
    method: "POST",
    path: "/api/v1/posts",
    token,
    body: { content: "Hola desde el test", scheduled_local: tomorrowAt9Madrid(), timezone: "Europe/Madrid", ...extra },
  });
}

describe("authentication", () => {
  it("rejects missing, forged and wrong-audience tokens", async () => {
    expect((await call(postsRoute.GET, { method: "GET", path: "/api/v1/posts" })).body.error.code).toBe("unauthenticated");
    const forged = `${ana.slice(0, -4)}AAAA`;
    expect((await call(postsRoute.GET, { method: "GET", path: "/api/v1/posts", token: forged })).status).toBe(401);
  });
});

describe("cross-tenant isolation (enforced by Postgres RLS, not by the handler)", () => {
  it("another tenant cannot read, edit, cancel or publish a post: 404, and nothing changes", async () => {
    const before = (await env.owner.query("SELECT status, content, updated_at FROM posts WHERE id = $1", [ACME_POST])).rows[0];
    const params = { id: ACME_POST };
    const get = await call(postRoute.GET, { method: "GET", path: `/api/v1/posts/${ACME_POST}`, token: diego, params });
    const patch = await call(postRoute.PATCH, { method: "PATCH", path: `/api/v1/posts/${ACME_POST}`, token: diego, params, body: { content: "pwned" } });
    const del = await call(postRoute.DELETE, { method: "DELETE", path: `/api/v1/posts/${ACME_POST}`, token: diego, params });
    const pub = await call(publishRoute.POST, {
      method: "POST",
      path: `/api/v1/posts/${ACME_POST}/publish`,
      token: diego,
      params,
      headers: { "idempotency-key": randomUUID() },
    });
    for (const r of [get, patch, del, pub]) {
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe("post_not_found");
    }
    const after = (await env.owner.query("SELECT status, content, updated_at FROM posts WHERE id = $1", [ACME_POST])).rows[0];
    expect(after).toEqual(before);
  });

  it("listing only returns the caller's tenant", async () => {
    const { body } = await call(postsRoute.GET, { method: "GET", path: "/api/v1/posts?limit=100", token: diego });
    const globexAmbassadors = SEED_AMBASSADORS.filter((a) => a.tenant === "globex").map((a) => a.id);
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.every((p: { ambassador_id: string }) => globexAmbassadors.includes(p.ambassador_id))).toBe(true);
  });

  it("cannot schedule for an Embajador of another tenant", async () => {
    const r = await createScheduled(ana, { ambassador_id: amb("Diego") });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("unknown_ambassador");
  });

  it("ambassadors endpoint is tenant-scoped", async () => {
    const { body } = await call(ambassadorsRoute.GET, { method: "GET", path: "/api/v1/ambassadors", token: ana });
    expect(body.data.map((a: { display_name: string }) => a.display_name).sort()).toEqual(["Ana", "Bruno", "Carla"]);
  });
});

describe("POST /api/v1/posts", () => {
  it("creates a scheduled post from a Madrid wall-clock time, stored as the right UTC instant", async () => {
    const local = tomorrowAt9Madrid();
    const r = await createScheduled(ana);
    expect(r.status).toBe(201);
    const expected = (zonedLocalToUtc(local, "Europe/Madrid") as { instant: Date }).instant.toISOString();
    expect(r.body).toMatchObject({ status: "scheduled", scheduled_at: expected, due_at: expected, timezone: "Europe/Madrid", ambassador_id: amb("Ana") });
    const { rows: [db] } = await env.owner.query("SELECT tenant_id, created_by FROM posts WHERE id = $1", [r.body.id]);
    expect(db).toEqual({ tenant_id: SEED_TENANTS.acme, created_by: amb("Ana") });
  });

  it("creates drafts without a schedule and posts for another Embajador of the same tenant", async () => {
    const draft = await call(postsRoute.POST, { method: "POST", path: "/api/v1/posts", token: ana, body: { content: "borrador", status: "draft" } });
    expect(draft.body).toMatchObject({ status: "draft", scheduled_at: null });
    const forBruno = await createScheduled(ana, { ambassador_id: amb("Bruno") });
    expect(forBruno.body.ambassador_name).toBe("Bruno");
  });

  it("validates input with typed errors", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ content: "" }, "validation_failed"],
      [{ content: "x", status: "published" }, "validation_failed"],
      [{ content: "x", hacker: true }, "validation_failed"],
      [{ content: "x", scheduled_local: "2020-01-01T09:00", timezone: "Europe/Madrid" }, "scheduled_in_past"],
      [{ content: "x", scheduled_local: "2027-03-28T02:30", timezone: "Europe/Madrid" }, "nonexistent_local_time"],
      [{ content: "x", scheduled_local: "2099-01-01T09:00", timezone: "Europe/Madrid" }, "too_far_ahead"],
      [{ content: "x", scheduled_at: "2030-01-01T09:00:00", timezone: "Europe/Madrid" }, "invalid_instant"],
      [{ content: "x" }, "missing_schedule"],
    ];
    for (const [body, code] of cases) {
      const r = await call(postsRoute.POST, { method: "POST", path: "/api/v1/posts", token: ana, body });
      expect([r.status, r.body.error?.code]).toEqual([422, code]);
    }
  });
});

describe("PATCH / DELETE", () => {
  it("edits content and reschedules", async () => {
    const { body: post } = await createScheduled(ana);
    const r = await call(postRoute.PATCH, {
      method: "PATCH",
      path: `/api/v1/posts/${post.id}`,
      token: bruno, // same tenant
      params: { id: post.id },
      body: { content: "editado", scheduled_at: new Date(Date.now() + 3 * 3600 * 1000).toISOString() },
    });
    expect(r.status).toBe(200);
    expect(r.body.content).toBe("editado");
    expect(r.body.due_at).toBe(r.body.scheduled_at);
  });

  it("rejects editing or cancelling published and in-flight posts", async () => {
    const published = seedUuid("ana-published");
    for (const handler of [postRoute.PATCH, postRoute.DELETE]) {
      const r = await call(handler, { method: "X", path: "/", token: ana, params: { id: published }, body: handler === postRoute.PATCH ? { content: "x" } : undefined });
      expect([r.status, r.body.error.code]).toEqual([409, "post_published"]);
    }
    const { body: post } = await createScheduled(ana, { ambassador_id: amb("Carla") });
    await env.owner.query(
      "UPDATE posts SET status = 'publishing', lease_owner = 'w', lease_expires_at = now() + interval '1 minute' WHERE id = $1",
      [post.id],
    );
    const r = await call(postRoute.DELETE, { method: "DELETE", path: "/", token: ana, params: { id: post.id } });
    expect([r.status, r.body.error.code]).toEqual([409, "post_publishing"]);
    await env.owner.query("UPDATE posts SET status = 'scheduled', lease_owner = NULL, lease_expires_at = NULL WHERE id = $1", [post.id]);
  });

  it("cancel is idempotent", async () => {
    const { body: post } = await createScheduled(ana);
    const first = await call(postRoute.DELETE, { method: "DELETE", path: "/", token: ana, params: { id: post.id } });
    const again = await call(postRoute.DELETE, { method: "DELETE", path: "/", token: ana, params: { id: post.id } });
    expect([first.status, first.body.status, again.status, again.body.status]).toEqual([200, "cancelled", 200, "cancelled"]);
  });

  it("a failed post (DLQ) is requeued by giving it a new time: attempts and error reset", async () => {
    const failed = seedUuid("diego-failed");
    const r = await call(postRoute.PATCH, {
      method: "PATCH",
      path: "/",
      token: diego,
      params: { id: failed },
      body: { scheduled_at: new Date(Date.now() + 3600_000).toISOString() },
    });
    expect(r.body).toMatchObject({ status: "scheduled", attempts: 0, last_error: null });
  });

  it("invalid ids are 404, not 500", async () => {
    const r = await call(postRoute.GET, { method: "GET", path: "/", token: ana, params: { id: "not-a-uuid" } });
    expect(r.status).toBe(404);
  });
});

describe("POST /api/v1/posts/:id/publish (Idempotency-Key)", () => {
  const publish = (token: string, id: string, key?: string) =>
    call(publishRoute.POST, {
      method: "POST",
      path: `/api/v1/posts/${id}/publish`,
      token,
      params: { id },
      headers: key ? { "idempotency-key": key } : {},
    });

  it("requires the header", async () => {
    const { body: post } = await createScheduled(ana);
    expect((await publish(ana, post.id)).body.error.code).toBe("idempotency_key_required");
  });

  it("moves the post to the head of the queue (due now) and replays on retry without a second change", async () => {
    const { body: post } = await createScheduled(ana);
    const key = randomUUID();
    const first = await publish(ana, post.id, key);
    expect(first.status).toBe(202);
    expect(new Date(first.body.due_at).getTime()).toBeLessThanOrEqual(Date.now());
    const { rows: [afterFirst] } = await env.owner.query("SELECT updated_at FROM posts WHERE id = $1", [post.id]);

    const retry = await publish(ana, post.id, key);
    expect(retry.status).toBe(202);
    expect(retry.headers.get("idempotent-replayed")).toBe("true");
    expect(retry.body).toEqual(first.body);
    const { rows: [afterRetry] } = await env.owner.query("SELECT updated_at FROM posts WHERE id = $1", [post.id]);
    expect(afterRetry.updated_at).toEqual(afterFirst.updated_at);
  });

  it("concurrent duplicates: exactly one executes, the rest replay the same response", async () => {
    const { body: post } = await createScheduled(ana);
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 6 }, () => publish(ana, post.id, key)));
    expect(results.every((r) => r.status === 202)).toBe(true);
    expect(results.filter((r) => r.headers.get("idempotent-replayed") !== "true")).toHaveLength(1);
    expect(new Set(results.map((r) => JSON.stringify(r.body))).size).toBe(1);
  });

  it("same key for a different request is rejected; keys are scoped per tenant", async () => {
    const { body: p1 } = await createScheduled(ana);
    const { body: p2 } = await createScheduled(ana);
    const key = randomUUID();
    await publish(ana, p1.id, key);
    const reused = await publish(ana, p2.id, key);
    expect([reused.status, reused.body.error.code]).toEqual([422, "idempotency_key_reused"]);

    // The same key value in another tenant is unrelated (and the post is invisible there).
    const other = await publish(diego, p1.id, key);
    expect(other.status).toBe(404);
  });

  it("deterministic errors are stored and replayed too", async () => {
    const key = randomUUID();
    const a = await publish(ana, seedUuid("ana-published"), key);
    const b = await publish(ana, seedUuid("ana-published"), key);
    expect([a.status, a.body.error.code]).toEqual([409, "post_already_published"]);
    expect(b.body).toEqual(a.body);
    expect(b.headers.get("idempotent-replayed")).toBe("true");
  });
});

describe("GET /api/v1/posts (keyset pagination)", () => {
  it("pages through everything once, newest first, with status filter and cursor validation", async () => {
    for (let i = 0; i < 12; i++) await createScheduled(bruno, { ambassador_id: amb("Bruno") });
    const { rows: [{ n }] } = await env.owner.query("SELECT count(*)::int AS n FROM posts WHERE tenant_id = $1", [SEED_TENANTS.acme]);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const path: string = `/api/v1/posts?limit=7${cursor ? `&cursor=${cursor}` : ""}`;
      const { body } = await call(postsRoute.GET, { method: "GET", path, token: bruno });
      seen.push(...body.data.map((p: { id: string }) => p.id));
      cursor = body.next_cursor;
    } while (cursor);
    expect(seen).toHaveLength(n);
    expect(new Set(seen).size).toBe(n);

    const drafts = await call(postsRoute.GET, { method: "GET", path: "/api/v1/posts?status=draft", token: bruno });
    expect(drafts.body.data.every((p: { status: string }) => p.status === "draft")).toBe(true);
    expect((await call(postsRoute.GET, { method: "GET", path: "/api/v1/posts?cursor=garbage", token: bruno })).body.error.code).toBe("invalid_cursor");
    expect((await call(postsRoute.GET, { method: "GET", path: "/api/v1/posts?limit=1000", token: bruno })).status).toBe(422);
  });

  it("exposes why a post waits: typed error and the Embajador's throttle", async () => {
    await env.owner.query(
      "UPDATE ambassadors SET throttled_until = now() + interval '20 seconds', throttle_reason = 'rate_limited' WHERE id = $1",
      [amb("Ana")],
    );
    await env.owner.query(
      "UPDATE posts SET last_error_code = 'rate_limited', last_error_detail = 'waiting Retry-After 20s (provider user limit)' WHERE id = $1",
      [ACME_POST],
    );
    const { body } = await call(postRoute.GET, { method: "GET", path: "/", token: ana, params: { id: ACME_POST } });
    expect(body.last_error.code).toBe("rate_limited");
    expect(body.ambassador_throttle.reason).toBe("rate_limited");
  });
});
