import { withTransaction, type Db, type Tx } from "@ploot/db";
import type { AttemptOutcome, ThrottleReason } from "./errors.js";

export interface ClaimedPost {
  id: string;
  tenant_id: string;
  ambassador_id: string;
  content: string;
  attempts: number;
  scheduled_at: Date;
}

export interface ClaimLimits {
  workerId: string;
  limit: number;
  leaseSec: number;
  globalMaxInFlight: number;
  tenantMaxInFlight: number;
}

export interface ClaimResult {
  posts: ClaimedPost[];
  /** Why fewer posts than `limit` were claimed (for logs/metrics). */
  limitedBy: "none" | "app_paused" | "app_budget" | "global_in_flight" | "nothing_due";
  budgetTokens: number;
}

const APP_BUCKET = "provider_app";

/** Applies the configured budget; tokens are clamped to the new capacity. */
export async function configureAppBucket(db: Db, capacity: number, refillPerSec: number): Promise<void> {
  await db.query(
    `UPDATE rate_buckets SET capacity = $2, refill_per_sec = $3, tokens = LEAST(tokens, $2) WHERE name = $1`,
    [APP_BUCKET, capacity, refillPerSec],
  );
}

/**
 * Claims due posts in one short transaction:
 *  1. Locks the shared app bucket row: claims from all replicas are serialised, so the global
 *     caps below are exact, and the budget is refilled lazily (token bucket).
 *  2. Picks only the head of each Embajador's queue (earliest due), skipping Embajadores that are
 *     throttled or already have a post in flight, ranks heads round-robin across tenants and
 *     respects the per-tenant in-flight cap.
 *  3. Locks the chosen rows with FOR UPDATE SKIP LOCKED (rows held by API writers are skipped, not
 *     waited on) and moves them to `publishing` with a lease.
 */
export async function claimPosts(db: Db, l: ClaimLimits): Promise<ClaimResult> {
  return withTransaction(db, async (tx) => {
    const { rows: [bucket] } = await tx.query<{
      capacity: number;
      refill_per_sec: number;
      tokens: number;
      elapsed: number;
      paused: boolean;
    }>(
      `SELECT capacity, refill_per_sec, tokens,
              GREATEST(0, EXTRACT(EPOCH FROM now() - updated_at))::float8 AS elapsed,
              paused_until > now() AS paused
         FROM rate_buckets WHERE name = $1 FOR UPDATE`,
      [APP_BUCKET],
    );
    if (!bucket) throw new Error("rate bucket provider_app missing (migration 0003)");
    const available = Math.min(bucket.capacity, bucket.tokens + bucket.elapsed * bucket.refill_per_sec);

    const { rows: [flight] } = await tx.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM posts WHERE status = 'publishing'",
    );
    const globalRoom = l.globalMaxInFlight - flight!.n;
    const allowed = bucket.paused ? 0 : Math.min(l.limit, Math.floor(available), globalRoom);

    let posts: ClaimedPost[] = [];
    if (allowed > 0) {
      ({ rows: posts } = await tx.query<ClaimedPost>(CLAIM_SQL, [allowed, l.tenantMaxInFlight, l.workerId, l.leaseSec]));
    }
    await tx.query("UPDATE rate_buckets SET tokens = $2, updated_at = now() WHERE name = $1", [
      APP_BUCKET,
      available - posts.length,
    ]);

    let limitedBy: ClaimResult["limitedBy"] = "none";
    if (posts.length < l.limit) {
      if (bucket.paused) limitedBy = "app_paused";
      else if (globalRoom <= posts.length) limitedBy = "global_in_flight";
      else if (Math.floor(available) <= posts.length) limitedBy = "app_budget";
      else limitedBy = "nothing_due";
    }
    return { posts, limitedBy, budgetTokens: available - posts.length };
  });
}

export const CLAIM_SQL = `
WITH busy_tenants AS (
  SELECT tenant_id, count(*) AS n FROM posts WHERE status = 'publishing' GROUP BY tenant_id
),
heads AS (
  SELECT DISTINCT ON (p.ambassador_id) p.id, p.tenant_id, p.due_at
    FROM posts p
    JOIN ambassadors a ON a.id = p.ambassador_id
   WHERE p.status = 'scheduled'
     AND p.due_at <= now()
     AND a.throttled_until <= now()
     AND NOT EXISTS (
       SELECT 1 FROM posts q WHERE q.ambassador_id = p.ambassador_id AND q.status = 'publishing')
   ORDER BY p.ambassador_id, p.due_at, p.id
),
ranked AS (
  SELECT h.id, h.due_at,
         row_number() OVER (PARTITION BY h.tenant_id ORDER BY h.due_at, h.id) + COALESCE(b.n, 0) AS slot
    FROM heads h LEFT JOIN busy_tenants b USING (tenant_id)
),
picked AS (
  SELECT p.id
    FROM posts p JOIN ranked r ON r.id = p.id
   WHERE r.slot <= $2 AND p.status = 'scheduled'
   ORDER BY r.slot, r.due_at
   LIMIT $1
     FOR UPDATE OF p SKIP LOCKED
)
UPDATE posts p
   SET status = 'publishing',
       attempts = p.attempts + 1,
       lease_owner = $3,
       lease_expires_at = now() + make_interval(secs => $4)
  FROM picked
 WHERE p.id = picked.id
RETURNING p.id, p.tenant_id, p.ambassador_id, p.content, p.attempts, p.scheduled_at`;

/** Persisted (committed) BEFORE calling the provider: proof that the request may have been sent. */
export async function startAttempt(db: Db, post: ClaimedPost, workerId: string): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO publish_attempts (post_id, tenant_id, ambassador_id, attempt, worker_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [post.id, post.tenant_id, post.ambassador_id, post.attempts, workerId],
  );
  return rows[0]!.id;
}

export type PostTransition =
  | { kind: "published"; externalId: string }
  /** delayMs = null keeps due_at (head of queue not advanced). */
  | { kind: "requeue"; delayMs: number | null; refundAttempt: boolean; errorCode?: string; detail?: string }
  | { kind: "fail"; errorCode: string; detail: string };

export interface OutcomePlan {
  post: PostTransition;
  attempt?: {
    id: number;
    outcome: AttemptOutcome;
    httpStatus?: number;
    errorCode?: string;
    retryAfterSec?: number;
    durationMs: number;
  };
  throttle?: { untilSec: number | "infinity"; reason: ThrottleReason; extendOnly?: boolean };
  pauseAppSec?: number;
  revokeToken?: boolean;
}

/**
 * Applies a decided outcome atomically. Returns false if this worker no longer owns the post
 * (lease reaped): nothing is written then, except that a real success always wins over an
 * `outcome_unknown` verdict, because the provider's truth beats our guess.
 */
export async function applyOutcome(db: Db, post: ClaimedPost, workerId: string, plan: OutcomePlan): Promise<boolean> {
  return withTransaction(db, async (tx) => {
    const owned = await transitionPost(tx, post, workerId, plan.post);
    if (plan.attempt) {
      const a = plan.attempt;
      await tx.query(
        `UPDATE publish_attempts
            SET finished_at = now(), outcome = $2, http_status = $3, error_code = $4,
                retry_after_sec = $5, duration_ms = $6
          WHERE id = $1`,
        [a.id, a.outcome, a.httpStatus ?? null, a.errorCode ?? null, a.retryAfterSec ?? null, a.durationMs],
      );
    }
    if (!owned) return false;

    if (plan.throttle) {
      const until = plan.throttle.untilSec === "infinity" ? "'infinity'::timestamptz" : "now() + make_interval(secs => $2)";
      const params: unknown[] = [post.ambassador_id];
      if (plan.throttle.untilSec !== "infinity") params.push(plan.throttle.untilSec);
      params.push(plan.throttle.reason);
      const reasonParam = `$${params.length}`;
      await tx.query(
        `UPDATE ambassadors SET throttled_until = ${until}, throttle_reason = ${reasonParam}
          WHERE id = $1 ${plan.throttle.extendOnly ? `AND throttled_until < ${until}` : ""}`,
        params,
      );
    }
    if (plan.pauseAppSec !== undefined) {
      await tx.query(
        `UPDATE rate_buckets
            SET paused_until = GREATEST(paused_until, now() + make_interval(secs => $2)),
                pause_reason = 'provider_app_rate_limited'
          WHERE name = $1`,
        [APP_BUCKET, plan.pauseAppSec],
      );
    }
    if (plan.revokeToken) {
      await tx.query(
        `UPDATE provider_tokens SET status = 'revoked', revoked_at = COALESCE(revoked_at, now())
          WHERE ambassador_id = $1`,
        [post.ambassador_id],
      );
    }
    return true;
  });
}

async function transitionPost(tx: Tx, post: ClaimedPost, workerId: string, t: PostTransition): Promise<boolean> {
  const mine = "id = $1 AND status = 'publishing' AND lease_owner = $2";
  let res;
  switch (t.kind) {
    case "published":
      res = await tx.query(
        `UPDATE posts
            SET status = 'published', external_id = $3, published_at = now(),
                lease_owner = NULL, lease_expires_at = NULL, last_error_code = NULL, last_error_detail = NULL
          WHERE (${mine}) OR (id = $1 AND status = 'failed' AND last_error_code = 'outcome_unknown')`,
        [post.id, workerId, t.externalId],
      );
      break;
    case "requeue":
      res = await tx.query(
        `UPDATE posts
            SET status = 'scheduled',
                due_at = CASE WHEN $3::int IS NULL THEN due_at ELSE now() + make_interval(secs => $3::int / 1000.0) END,
                attempts = CASE WHEN $4 THEN GREATEST(attempts - 1, 0) ELSE attempts END,
                last_error_code = $5, last_error_detail = $6,
                lease_owner = NULL, lease_expires_at = NULL
          WHERE ${mine}`,
        [post.id, workerId, t.delayMs, t.refundAttempt, t.errorCode ?? null, t.detail ?? null],
      );
      break;
    case "fail":
      res = await tx.query(
        `UPDATE posts
            SET status = 'failed', last_error_code = $3, last_error_detail = $4,
                lease_owner = NULL, lease_expires_at = NULL
          WHERE ${mine}`,
        [post.id, workerId, t.errorCode, t.detail],
      );
      break;
  }
  return (res.rowCount ?? 0) > 0;
}

export interface ReapedPost {
  id: string;
  tenant_id: string;
  ambassador_id: string;
  maybe_sent: boolean;
}

/**
 * Recovers posts whose worker died (lease expired):
 *  - no attempt was opened  => the request never left: back to the queue, attempt refunded;
 *  - an attempt is still open => it may have been published: `failed/outcome_unknown`, never
 *    retried automatically (at-most-once; the provider offers no idempotency).
 */
export async function reapExpiredLeases(db: Db, limit = 100): Promise<ReapedPost[]> {
  const { rows } = await db.query<ReapedPost>(
    `WITH expired AS (
       SELECT id FROM posts
        WHERE status = 'publishing' AND lease_expires_at < now()
        ORDER BY lease_expires_at
        LIMIT $1
          FOR UPDATE SKIP LOCKED
     ),
     classified AS (
       SELECT e.id,
              EXISTS (SELECT 1 FROM publish_attempts a WHERE a.post_id = e.id AND a.finished_at IS NULL) AS maybe_sent
         FROM expired e
     ),
     upd AS (
       UPDATE posts p
          SET status = CASE WHEN c.maybe_sent THEN 'failed' ELSE 'scheduled' END::post_status,
              attempts = CASE WHEN c.maybe_sent THEN p.attempts ELSE GREATEST(p.attempts - 1, 0) END,
              last_error_code = CASE WHEN c.maybe_sent THEN 'outcome_unknown' ELSE p.last_error_code END,
              last_error_detail = CASE WHEN c.maybe_sent
                THEN 'worker lost mid-publish; not retried automatically to avoid a duplicate post'
                ELSE p.last_error_detail END,
              lease_owner = NULL, lease_expires_at = NULL
         FROM classified c
        WHERE p.id = c.id
       RETURNING p.id, p.tenant_id, p.ambassador_id, c.maybe_sent
     ),
     closed AS (
       UPDATE publish_attempts a
          SET finished_at = now(), outcome = 'lease_expired', error_code = 'outcome_unknown'
         FROM upd
        WHERE a.post_id = upd.id AND a.finished_at IS NULL
     )
     SELECT * FROM upd`,
    [limit],
  );
  return rows;
}
