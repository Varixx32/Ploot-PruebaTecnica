import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, type Db } from "@ploot/db";
import { Metrics, refreshQueueGauges } from "../src/metrics.js";
import { insertDuePosts, setupTestDb, type TestDb } from "./support/db.js";

let tdb: TestDb;
let db: Db;
beforeAll(async () => {
  tdb = await setupTestDb();
  db = createPool({ connectionString: tdb.workerUrl, max: 1 });
  await tdb.reset("x".repeat(32));
});
afterAll(async () => {
  await db.end();
  await tdb.close();
});

describe("queue gauges", () => {
  it("work with an unpaused bucket (paused_until = -infinity) and report backlog and lag", async () => {
    await insertDuePosts(tdb.owner, "Ana", 3, -120);
    const m = new Metrics();
    await refreshQueueGauges(db, m);
    const text = m.render();
    expect(text).toMatch(/^ploot_queue_due_posts 3$/m);
    expect(text).toMatch(/^ploot_app_paused_seconds 0$/m);
    const lag = Number(/^ploot_queue_oldest_due_lag_seconds (\S+)$/m.exec(text)![1]);
    expect(lag).toBeGreaterThanOrEqual(120);
  });

  it("report a provider app pause", async () => {
    await tdb.owner.query("UPDATE rate_buckets SET paused_until = now() + interval '30 seconds'");
    const m = new Metrics();
    await refreshQueueGauges(db, m);
    const paused = Number(/^ploot_app_paused_seconds (\S+)$/m.exec(m.render())![1]);
    expect(paused).toBeGreaterThan(25);
  });
});
