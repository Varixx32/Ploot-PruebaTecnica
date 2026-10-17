import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { amb, insertDuePosts, pending, setupTestDb, statusCounts, waitFor, type TestDb } from "./support/db.js";
import { startMock, type RunningMock } from "./support/mock-provider.js";
import { startWorker, type TestWorker } from "./support/worker.js";

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

const attempts = async (ambassador: string) =>
  (
    await tdb.owner.query<{ outcome: string; error_code: string | null; retry_after_sec: number | null }>(
      "SELECT outcome, error_code, retry_after_sec FROM publish_attempts WHERE ambassador_id = $1 ORDER BY id",
      [amb(ambassador).id],
    )
  ).rows;

describe("rate limits: throttle, never retry-storm", () => {
  it("per-Embajador 429 (pacing disabled on purpose): waits Retry-After, refunds, no soft-ban", async () => {
    // Every 429 counts as a strike at this provider, even when Retry-After is respected:
    // 429 handling is the safety net, proactive pacing (next test) is the primary control.
    mock = await startMock({ userRateLimit: { capacity: 1, refillPerSec: 1 } });
    await tdb.reset(mock.fixtureSecret);
    const ids = await insertDuePosts(tdb.owner, "Bruno", 4);
    workers.push(await startWorker(tdb, mock.url));

    await waitFor(() => statusCounts(tdb.owner), (c) => c.published === 4, { timeoutMs: 20_000 });
    expect(await mock.admin("/restrictions")).toEqual([]);

    const a = await attempts("Bruno");
    const limited = a.filter((x) => x.outcome === "rate_limited_user");
    expect(limited.length).toBeGreaterThan(0);
    expect(limited.every((x) => x.retry_after_sec === 1)).toBe(true);
    // 429s refunded their attempt: every post published on its first counted attempt.
    const { rows } = await tdb.owner.query("SELECT attempts FROM posts WHERE id = ANY($1)", [ids]);
    expect(rows.every((r) => r.attempts === 1)).toBe(true);
  });

  it("published in queue order: a 429 does not let a later post overtake the head", async () => {
    mock = await startMock({ userRateLimit: { capacity: 1, refillPerSec: 1 } });
    await tdb.reset(mock.fixtureSecret);
    const ids = [
      ...(await insertDuePosts(tdb.owner, "Bruno", 1, -30)),
      ...(await insertDuePosts(tdb.owner, "Bruno", 1, -20)),
      ...(await insertDuePosts(tdb.owner, "Bruno", 1, -10)),
    ];
    workers.push(await startWorker(tdb, mock.url));
    await waitFor(() => statusCounts(tdb.owner), (c) => c.published === 3, { timeoutMs: 20_000 });
    const { rows } = await tdb.owner.query<{ id: string }>(
      "SELECT id FROM posts WHERE id = ANY($1) ORDER BY published_at",
      [ids],
    );
    expect(rows.map((r) => r.id)).toEqual(ids);
  });

  it("proactive pacing avoids 429s altogether", async () => {
    mock = await startMock({ userRateLimit: { capacity: 1, refillPerSec: 2 } });
    await tdb.reset(mock.fixtureSecret);
    await insertDuePosts(tdb.owner, "Bruno", 3);
    workers.push(await startWorker(tdb, mock.url, { ambassadorMinIntervalSec: 0.6 }));
    await waitFor(() => statusCounts(tdb.owner), (c) => c.published === 3, { timeoutMs: 20_000 });
    expect((await attempts("Bruno")).map((x) => x.outcome)).toEqual(["published", "published", "published"]);
  });

  it("app-level 429 pauses every worker via the shared bucket", async () => {
    mock = await startMock({ appRateLimit: { capacity: 1, refillPerSec: 1 } });
    await tdb.reset(mock.fixtureSecret);
    for (const n of ["Ana", "Bruno", "Diego"]) await insertDuePosts(tdb.owner, n, 1);
    workers = await Promise.all([startWorker(tdb, mock.url), startWorker(tdb, mock.url)]);

    await waitFor(() => statusCounts(tdb.owner), (c) => c.published === 3, { timeoutMs: 20_000 });
    const { rows } = await tdb.owner.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM publish_attempts WHERE outcome = 'rate_limited_app'",
    );
    expect(rows[0]!.n).toBeGreaterThan(0);
    // Once paused, workers stop calling: far fewer 429s than a naive retry loop would produce.
    expect(rows[0]!.n).toBeLessThanOrEqual(4);
  });
});

describe("tokens", () => {
  it("expired token is refreshed before publishing and the rotated pair is stored encrypted", async () => {
    mock = await startMock();
    await tdb.reset(mock.fixtureSecret);
    await insertDuePosts(tdb.owner, "Carla", 1);
    workers.push(await startWorker(tdb, mock.url));
    await waitFor(() => statusCounts(tdb.owner), (c) => c.published === 1);

    const { rows: [t] } = await tdb.owner.query(
      "SELECT refreshed_at, expires_at > now() AS fresh, access_token_enc, key_version FROM provider_tokens WHERE ambassador_id = $1",
      [amb("Carla").id],
    );
    expect(t.refreshed_at).not.toBeNull();
    expect(t.fresh).toBe(true);
    const stored = tdb.cipher.decrypt(t.access_token_enc, t.key_version, amb("Carla").id, "access_token");
    expect(stored).not.toBe(mock.at("pu_acme_carla")); // rotated
  });

  it("revoked at the provider: typed failure, one attempt, queue paused, other posts untouched", async () => {
    mock = await startMock();
    await tdb.reset(mock.fixtureSecret);
    const [first, second] = await insertDuePosts(tdb.owner, "Fede", 2);
    workers.push(await startWorker(tdb, mock.url));
    // Same due_at: whichever is the head of Fede's queue fails, the other must stay untouched.
    await waitFor(() => statusCounts(tdb.owner), (c) => c.failed === 1);
    await new Promise((r) => setTimeout(r, 300));

    const { rows: posts } = await tdb.owner.query(
      "SELECT id, status, attempts, last_error_code FROM posts WHERE id = ANY($1) ORDER BY scheduled_at, id",
      [[first, second]],
    );
    const failed = posts.find((p) => p.status === "failed");
    const waiting = posts.find((p) => p.status === "scheduled");
    expect(failed).toMatchObject({ attempts: 1, last_error_code: "token_revoked" });
    expect(waiting).toMatchObject({ attempts: 0 });
    expect(await attempts("Fede")).toHaveLength(1);

    const { rows: [a] } = await tdb.owner.query(
      "SELECT throttle_reason, throttled_until = 'infinity' AS paused FROM ambassadors WHERE id = $1",
      [amb("Fede").id],
    );
    expect(a).toEqual({ throttle_reason: "token_revoked", paused: true });
    const { rows: [tok] } = await tdb.owner.query("SELECT status FROM provider_tokens WHERE ambassador_id = $1", [amb("Fede").id]);
    expect(tok.status).toBe("revoked");
  });

  it("revoked mid-batch (expired token whose refresh is rejected): fails typed without retries", async () => {
    mock = await startMock();
    await tdb.reset(mock.fixtureSecret);
    await mock.admin("/tokens/pu_globex_elena/revoke", "POST");
    await insertDuePosts(tdb.owner, "Elena", 1);
    workers.push(await startWorker(tdb, mock.url));
    await waitFor(() => statusCounts(tdb.owner), (c) => c.failed === 1);
    const a = await attempts("Elena");
    expect(a).toEqual([{ outcome: "token_revoked", error_code: "token_revoked", retry_after_sec: null }]);
  });
});

describe("transient provider errors", () => {
  it("5xx: exponential backoff up to 5 attempts, then failed (DLQ) with a typed error", async () => {
    // The provider rate-limits before failing: give it room so only the 5xx path is exercised.
    mock = await startMock({ errorRate5xx: 1, userRateLimit: { capacity: 100, refillPerSec: 100 } });
    await tdb.reset(mock.fixtureSecret);
    const [id] = await insertDuePosts(tdb.owner, "Ana", 1);
    workers.push(await startWorker(tdb, mock.url));
    await waitFor(() => statusCounts(tdb.owner), (c) => c.failed === 1, { timeoutMs: 20_000 });

    const { rows: [p] } = await tdb.owner.query("SELECT attempts, last_error_code, last_error_detail FROM posts WHERE id = $1", [id]);
    expect(p.attempts).toBe(5);
    expect(p.last_error_code).toBe("provider_unavailable");
    expect(p.last_error_detail).toMatch(/gave up after 5 attempts/);
    expect((await attempts("Ana")).map((x) => x.outcome)).toEqual(Array(5).fill("provider_error"));
  });
});

describe("observability", () => {
  it("'why is Embajador X late?' is one query on ambassador_queue_status", async () => {
    mock = await startMock({ userRateLimit: { capacity: 1, refillPerSec: 0.05 } });
    await tdb.reset(mock.fixtureSecret);
    await insertDuePosts(tdb.owner, "Bruno", 3);
    workers.push(await startWorker(tdb, mock.url));
    await waitFor(() => attempts("Bruno"), (a) => a.some((x) => x.outcome === "rate_limited_user"));

    const { rows: [s] } = await tdb.owner.query(
      "SELECT due_now, throttle_reason, last_outcome, last_retry_after_sec FROM ambassador_queue_status WHERE ambassador_id = $1",
      [amb("Bruno").id],
    );
    expect(s).toMatchObject({ throttle_reason: "rate_limited", last_outcome: "rate_limited_user", last_retry_after_sec: 20 });
    expect(Number(s.due_now)).toBe(2);
  });
});

describe("worker metrics", () => {
  it("counts outcomes per type", async () => {
    mock = await startMock();
    await tdb.reset(mock.fixtureSecret);
    await insertDuePosts(tdb.owner, "Ana", 2);
    await insertDuePosts(tdb.owner, "Fede", 1);
    const w = await startWorker(tdb, mock.url);
    workers.push(w);
    await waitFor(() => statusCounts(tdb.owner), (c) => pending(c) === 0 || (c.published === 2 && c.failed === 1));
    expect(w.metrics.get("ploot_worker_publish_outcomes_total", { outcome: "published" })).toBe(2);
    expect(w.metrics.get("ploot_worker_publish_outcomes_total", { outcome: "token_revoked" })).toBe(1);
  });
});
