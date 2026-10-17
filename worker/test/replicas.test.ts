import { spawn } from "node:child_process";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createRng } from "../../mock/src/rng.js";
import { insertDuePosts, pending, setupTestDb, statusCounts, waitFor, type TestDb } from "./support/db.js";
import { startMock, type RunningMock } from "./support/mock-provider.js";
import { startWorker, type TestWorker } from "./support/worker.js";

interface Ledger {
  total: number;
  duplicates: { client_ref: string; count: number }[];
  records: { external_id: string; client_ref: string }[];
}

let tdb: TestDb;
let mock: RunningMock;
let workers: TestWorker[] = [];

beforeAll(async () => {
  tdb = await setupTestDb();
});
afterAll(async () => {
  await tdb.close();
});
afterEach(async () => {
  await Promise.all(workers.map((w) => w.stop()));
  workers = [];
  await mock?.close();
});

/** Fast-forwards time for the reaper: the lease of every in-flight post is now expired. */
const expireLeases = () => tdb.owner.query("UPDATE posts SET lease_expires_at = now() - interval '1 second' WHERE status = 'publishing'");

/** The provider's ledger and our DB must tell the same story, with zero duplicates. */
async function assertExactlyOncePerPublishedPost(): Promise<void> {
  const ledger = await mock.admin<Ledger>("/publishes");
  expect(ledger.duplicates).toEqual([]);
  const { rows } = await tdb.owner.query<{ id: string; external_id: string }>(
    "SELECT id, external_id FROM posts WHERE status = 'published'",
  );
  const byRef = new Map(ledger.records.map((r) => [r.client_ref, r.external_id]));
  for (const p of rows) expect(byRef.get(p.id)).toBe(p.external_id);
  expect(ledger.total).toBe(rows.length);
}

describe("safe with N replicas", () => {
  it("4 concurrent workers publish 60 posts exactly once, despite 5xx and expired tokens", async () => {
    mock = await startMock({
      latencyMaxMs: 30,
      errorRate5xx: 0.3,
      seed: 11,
      userRateLimit: { capacity: 1000, refillPerSec: 1000 },
      appRateLimit: { capacity: 1000, refillPerSec: 1000 },
    });
    await tdb.reset(mock.fixtureSecret);
    for (const name of ["Ana", "Bruno", "Carla", "Diego", "Elena"]) await insertDuePosts(tdb.owner, name, 12);

    workers = await Promise.all(Array.from({ length: 4 }, () => startWorker(tdb, mock.url, { maxAttempts: 10 })));
    const counts = await waitFor(() => statusCounts(tdb.owner), (c) => pending(c) === 0, { timeoutMs: 45_000 });

    expect(counts.published).toBe(60);
    await assertExactlyOncePerPublishedPost();
    // Work really was spread across replicas.
    const { rows } = await tdb.owner.query<{ n: number }>("SELECT count(DISTINCT worker_id)::int AS n FROM publish_attempts");
    expect(rows[0]!.n).toBeGreaterThan(1);
  });
});

describe("crash mid-publication", () => {
  it("dies after the provider published, before recording it: never republished (outcome_unknown)", async () => {
    mock = await startMock();
    await tdb.reset(mock.fixtureSecret);
    const [postId] = await insertDuePosts(tdb.owner, "Ana", 1);

    const crashing = await startWorker(tdb, mock.url, {}, {
      afterProviderResponse: () => {
        throw new Error("simulated crash after the provider call");
      },
    });
    workers.push(crashing);
    await waitFor(() => mock.admin<Ledger>("/publishes"), (l) => l.total === 1);
    await crashing.worker.drain();
    await crashing.stop();
    workers = [];

    const { rows: [stuck] } = await tdb.owner.query("SELECT status FROM posts WHERE id = $1", [postId]);
    expect(stuck.status).toBe("publishing");

    await expireLeases();
    workers.push(await startWorker(tdb, mock.url));
    const { rows: [post] } = await waitFor(
      () => tdb.owner.query("SELECT status, last_error_code FROM posts WHERE id = $1", [postId]),
      (r) => r.rows[0].status !== "publishing",
    );
    expect(post).toEqual({ status: "failed", last_error_code: "outcome_unknown" });

    // Give the healthy worker time to (wrongly) retry: it must not.
    await new Promise((r) => setTimeout(r, 300));
    expect((await mock.admin<Ledger>("/publishes")).total).toBe(1);
  });

  it("dies before sending: the post is requeued and published once, attempt refunded", async () => {
    mock = await startMock();
    await tdb.reset(mock.fixtureSecret);
    const [postId] = await insertDuePosts(tdb.owner, "Ana", 1);

    const crashing = await startWorker(tdb, mock.url, {}, {
      beforeAttempt: () => {
        throw new Error("simulated crash before the provider call");
      },
    });
    workers.push(crashing);
    await waitFor(() => statusCounts(tdb.owner), (c) => c.publishing === 1);
    await crashing.worker.drain();
    await crashing.stop();
    workers = [];

    await expireLeases();
    workers.push(await startWorker(tdb, mock.url));
    const { rows: [post] } = await waitFor(
      () => tdb.owner.query("SELECT status, attempts FROM posts WHERE id = $1", [postId]),
      (r) => r.rows[0].status === "published",
    );
    expect(post.attempts).toBe(1);
    await assertExactlyOncePerPublishedPost();
  });

  it("real process killed with SIGKILL while its request is in flight: at most one publication", async () => {
    // Pick a mock seed whose first latency draw is long (>1.5 s), so the kill lands mid-request.
    const seed = Array.from({ length: 200 }, (_, i) => i + 1).find((s) => createRng(s)() * 2000 > 1500)!;
    mock = await startMock({ latencyMaxMs: 2000, seed });
    await tdb.reset(mock.fixtureSecret);
    const [postId] = await insertDuePosts(tdb.owner, "Ana", 1);

    const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: {
        ...process.env,
        DATABASE_URL: tdb.workerUrl,
        PROVIDER_BASE_URL: mock.url,
        TOKEN_ENC_KEYS: tdb.tokenKeys,
        WORKER_HTTP_PORT: "0",
        WORKER_POLL_INTERVAL_MS: "20",
        WORKER_AMBASSADOR_MIN_INTERVAL_SEC: "0",
        WORKER_HTTP_TIMEOUT_MS: "4000",
        WORKER_LEASE_SEC: "30",
        LOG_LEVEL: "silent",
      },
      stdio: "ignore",
    });
    // The attempt row is committed right before the HTTP call: once it exists, the request is out.
    await waitFor(
      () => tdb.owner.query("SELECT count(*)::int AS n FROM publish_attempts WHERE post_id = $1", [postId]),
      (r) => r.rows[0].n === 1,
      { timeoutMs: 20_000 },
    );
    await new Promise((r) => setTimeout(r, 200));
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));

    // The provider finishes the publication even though the client died.
    await waitFor(() => mock.admin<Ledger>("/publishes"), (l) => l.total === 1, { timeoutMs: 5000 });
    expect((await statusCounts(tdb.owner)).publishing).toBe(1);

    await expireLeases();
    workers.push(await startWorker(tdb, mock.url));
    const { rows: [post] } = await waitFor(
      () => tdb.owner.query("SELECT status, last_error_code FROM posts WHERE id = $1", [postId]),
      (r) => r.rows[0].status !== "publishing",
    );
    expect(post).toEqual({ status: "failed", last_error_code: "outcome_unknown" });
    await new Promise((r) => setTimeout(r, 300));
    const ledger = await mock.admin<Ledger>("/publishes");
    expect(ledger.total).toBe(1);
    expect(ledger.duplicates).toEqual([]);
  });
});
