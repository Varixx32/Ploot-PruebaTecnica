import { createPool } from "@ploot/db";

/**
 * "Why is Embajador X late?" without reading code:
 *   docker compose exec worker node dist/why.js <name | provider_user_id | uuid>
 */
const needle = process.argv[2];
if (!needle || !process.env.DATABASE_URL) {
  console.error("usage: why <ambassador name | provider_user_id | uuid>   (needs DATABASE_URL)");
  process.exit(2);
}

const db = createPool({ connectionString: process.env.DATABASE_URL, max: 1, applicationName: "why" });

function explain(s: Record<string, unknown>): string {
  const until = s.throttled_until_text as string;
  switch (s.throttled ? s.throttle_reason : null) {
    case "token_revoked":
      return "Paused: the OAuth grant was revoked. Nothing will publish until the Embajador re-authenticates.";
    case "account_restricted":
      return `Paused: the provider restricted the account until ${String(until)}.`;
    case "rate_limited":
      return `Waiting for the provider's per-user Retry-After until ${String(until)}.`;
    case "pacing":
      return `Proactive pacing between posts until ${String(until)} (avoids bursts).`;
  }
  if (Number(s.in_flight) > 0) return "A post is being published right now.";
  if (Number(s.due_now) > 0) {
    return "Due posts waiting for a slot: check the app budget (ploot_app_paused_seconds) and global/tenant in-flight caps.";
  }
  return "Nothing due: the queue is up to date.";
}

try {
  const { rows: [status] } = await db.query(
    `SELECT s.*, a.provider_user_id,
            s.throttled_until > now() AS throttled,
            s.throttled_until::text AS throttled_until_text
       FROM ambassador_queue_status s JOIN ambassadors a ON a.id = s.ambassador_id
      WHERE s.ambassador_id::text = $1 OR a.provider_user_id = $1 OR lower(s.display_name) = lower($1)
      LIMIT 1`,
    [needle],
  );
  if (!status) {
    console.error(`No Embajador matches "${needle}"`);
    process.exit(1);
  }
  const { rows: attempts } = await db.query(
    `SELECT started_at, attempt, outcome, http_status, error_code, retry_after_sec, duration_ms, worker_id
       FROM publish_attempts WHERE ambassador_id = $1 ORDER BY started_at DESC LIMIT 10`,
    [status.ambassador_id],
  );
  const { rows: [app] } = await db.query(
    `SELECT CASE WHEN paused_until > now() THEN paused_until::text ELSE 'not paused' END AS paused_until
       FROM rate_buckets WHERE name = 'provider_app'`,
  );
  console.log(`\n${status.display_name} (${status.provider_user_id})`);
  console.log(`  => ${explain(status)}\n`);
  console.table([
    {
      due_now: Number(status.due_now),
      in_flight: Number(status.in_flight),
      oldest_due_scheduled_at: status.oldest_due_scheduled_at,
      throttled_until: status.throttled ? status.throttled_until_text : "not throttled",
      throttle_reason: status.throttle_reason,
      app_paused_until: app?.paused_until,
    },
  ]);
  console.log("Last provider attempts:");
  console.table(attempts);
} finally {
  await db.end();
}
