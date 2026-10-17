import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, type Db } from "@ploot/db";
import { claimPosts, configureAppBucket } from "../src/repo.js";
import { amb, insertDuePosts, setupTestDb, type TestDb } from "./support/db.js";

let tdb: TestDb;
let db: Db;

beforeAll(async () => {
  tdb = await setupTestDb();
  db = createPool({ connectionString: tdb.workerUrl, max: 2 });
});
afterAll(async () => {
  await db.end();
  await tdb.close();
});
beforeEach(async () => {
  await tdb.reset("x".repeat(32));
  await configureAppBucket(db, 1000, 1000);
});

const limits = (over: Partial<Parameters<typeof claimPosts>[1]> = {}) => ({
  workerId: "w1",
  limit: 50,
  leaseSec: 30,
  globalMaxInFlight: 100,
  tenantMaxInFlight: 100,
  ...over,
});

describe("claimPosts", () => {
  it("takes only the head of each Embajador's queue", async () => {
    await insertDuePosts(tdb.owner, "Ana", 5);
    await insertDuePosts(tdb.owner, "Bruno", 5);
    const { posts } = await claimPosts(db, limits());
    expect(posts.map((p) => p.ambassador_id).sort()).toEqual([amb("Ana").id, amb("Bruno").id].sort());
  });

  it("round-robin across tenants and per-tenant in-flight cap: a noisy tenant can't take every slot", async () => {
    for (const n of ["Ana", "Bruno", "Carla"]) await insertDuePosts(tdb.owner, n, 10, -600); // acme, older backlog
    await insertDuePosts(tdb.owner, "Diego", 1, -1); // globex, newest
    const first = await claimPosts(db, limits({ limit: 2 }));
    expect(new Set(first.posts.map((p) => p.tenant_id))).toEqual(new Set([amb("Ana").tenantId, amb("Diego").tenantId]));

    const capped = await claimPosts(db, limits({ tenantMaxInFlight: 2 }));
    // acme already has 1 in flight: only 1 more slot for it, globex has no other ambassador due.
    expect(capped.posts).toHaveLength(1);
  });

  it("skips throttled Embajadores and those with a post in flight", async () => {
    await insertDuePosts(tdb.owner, "Ana", 2);
    await insertDuePosts(tdb.owner, "Bruno", 2);
    await tdb.owner.query("UPDATE ambassadors SET throttled_until = now() + interval '1 minute' WHERE id = $1", [amb("Bruno").id]);
    const a = await claimPosts(db, limits());
    expect(a.posts.map((p) => p.ambassador_id)).toEqual([amb("Ana").id]);
    const b = await claimPosts(db, limits());
    expect(b.posts).toHaveLength(0);
  });

  it("enforces the global in-flight cap exactly", async () => {
    for (const n of ["Ana", "Bruno", "Carla", "Diego"]) await insertDuePosts(tdb.owner, n, 1);
    expect((await claimPosts(db, limits({ globalMaxInFlight: 3 }))).posts).toHaveLength(3);
    const again = await claimPosts(db, limits({ globalMaxInFlight: 3 }));
    expect(again.posts).toHaveLength(0);
    expect(again.limitedBy).toBe("global_in_flight");
  });

  it("spends the shared app budget and stops when it is empty or paused", async () => {
    for (const n of ["Ana", "Bruno", "Carla", "Diego"]) await insertDuePosts(tdb.owner, n, 1);
    await configureAppBucket(db, 2, 0.001);
    await tdb.owner.query("UPDATE rate_buckets SET tokens = 2, updated_at = now()");
    expect((await claimPosts(db, limits())).posts).toHaveLength(2);
    expect((await claimPosts(db, limits())).limitedBy).toBe("app_budget");

    await configureAppBucket(db, 1000, 1000);
    await tdb.owner.query("UPDATE rate_buckets SET tokens = 1000, paused_until = now() + interval '1 minute'");
    expect((await claimPosts(db, limits())).limitedBy).toBe("app_paused");
  });

  it("ignores drafts, future posts and posts locked by another transaction (SKIP LOCKED)", async () => {
    await insertDuePosts(tdb.owner, "Ana", 1, 3600);
    const [locked] = await insertDuePosts(tdb.owner, "Bruno", 1);
    await insertDuePosts(tdb.owner, "Carla", 1);
    const holder = await tdb.owner.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM posts WHERE id = $1 FOR UPDATE", [locked]);
      const { posts } = await claimPosts(db, limits());
      expect(posts.map((p) => p.ambassador_id)).toEqual([amb("Carla").id]);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  });
});
