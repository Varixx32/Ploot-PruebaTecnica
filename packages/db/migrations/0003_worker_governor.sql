-- Worker support: per-Embajador concurrency cap, distributed app-level rate governor and a
-- queue-status view that answers "why is Embajador X late?" with one query.

-- At most one post in flight per Embajador, enforced by Postgres rather than by worker code:
-- even a buggy or duplicated worker cannot burst one account.
CREATE UNIQUE INDEX posts_one_publishing_per_ambassador
  ON posts (ambassador_id) WHERE status = 'publishing';

-- Token buckets shared by every worker replica. The row lock taken by each claim serialises
-- claims, which makes the global caps exact instead of "per replica".
CREATE TABLE rate_buckets (
  name           text PRIMARY KEY,
  capacity       double precision NOT NULL CHECK (capacity >= 1),
  refill_per_sec double precision NOT NULL CHECK (refill_per_sec > 0),
  tokens         double precision NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- Set when the provider answers 429 with scope=app: every worker stops until then.
  paused_until   timestamptz NOT NULL DEFAULT '-infinity',
  pause_reason   text
);
-- Workers overwrite capacity/refill from their config at startup; this is just a safe default.
INSERT INTO rate_buckets (name, capacity, refill_per_sec, tokens) VALUES ('provider_app', 10, 1, 10);

GRANT SELECT ON rate_buckets TO ploot_app;
GRANT SELECT, UPDATE ON rate_buckets TO ploot_worker;

-- Reaper: find attempts that were sent but never finished.
CREATE INDEX publish_attempts_open_idx ON publish_attempts (post_id) WHERE finished_at IS NULL;

-- One row per Embajador: backlog, throttle and last provider outcome.
-- security_invoker: RLS of the caller applies (the API only sees its tenant).
CREATE VIEW ambassador_queue_status WITH (security_invoker = true) AS
SELECT
  a.id AS ambassador_id,
  a.tenant_id,
  a.display_name,
  a.throttled_until,
  a.throttle_reason,
  q.due_now,
  q.oldest_due_scheduled_at,
  q.in_flight,
  la.outcome AS last_outcome,
  la.error_code AS last_error_code,
  la.http_status AS last_http_status,
  la.retry_after_sec AS last_retry_after_sec,
  la.started_at AS last_attempt_at
FROM ambassadors a
CROSS JOIN LATERAL (
  SELECT
    count(*) FILTER (WHERE p.status = 'scheduled' AND p.due_at <= now()) AS due_now,
    min(p.scheduled_at) FILTER (WHERE p.status = 'scheduled' AND p.due_at <= now()) AS oldest_due_scheduled_at,
    count(*) FILTER (WHERE p.status = 'publishing') AS in_flight
  FROM posts p
  WHERE p.ambassador_id = a.id AND p.status IN ('scheduled', 'publishing')
) q
LEFT JOIN LATERAL (
  SELECT pa.outcome, pa.error_code, pa.http_status, pa.retry_after_sec, pa.started_at
  FROM publish_attempts pa
  WHERE pa.ambassador_id = a.id
  ORDER BY pa.started_at DESC
  LIMIT 1
) la ON true;

GRANT SELECT ON ambassador_queue_status TO ploot_app, ploot_worker;
