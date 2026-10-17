import { z } from "zod";
import { withTenant, type Db, type TenantContext, type Tx } from "@ploot/db";
import { ApiError } from "./http";
import { resolveSchedule } from "./time";

/*
 * Post repository. Note what is NOT here: no `WHERE tenant_id = ...` anywhere. Every query runs
 * inside withTenant(), and Postgres RLS restricts rows to the caller's tenant; inserts take the
 * tenant from app_current_tenant(). A missing filter can't leak data because there is no filter.
 */

export const POST_STATUSES = ["draft", "scheduled", "publishing", "published", "failed", "cancelled"] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

const DEFAULT_TZ = "Europe/Madrid";

export interface PostDto {
  id: string;
  ambassador_id: string;
  ambassador_name: string;
  content: string;
  status: PostStatus;
  scheduled_at: string | null;
  due_at: string | null;
  timezone: string;
  attempts: number;
  external_id: string | null;
  published_at: string | null;
  last_error: { code: string; detail: string | null } | null;
  /** Why a scheduled post is waiting (provider Retry-After, soft-ban, revoked token, pacing). */
  ambassador_throttle: { reason: string | null; until: string } | null;
  created_at: string;
  updated_at: string;
}

const SELECT_POST = `
  SELECT p.id, p.ambassador_id, a.display_name AS ambassador_name, p.content, p.status,
         p.scheduled_at, p.due_at, p.timezone, p.attempts, p.external_id, p.published_at,
         p.last_error_code, p.last_error_detail, p.created_at, p.updated_at,
         p.created_at::text AS cursor_ts,
         CASE WHEN a.throttled_until > now() THEN a.throttled_until::text END AS throttled_until,
         a.throttle_reason
    FROM posts p
    JOIN ambassadors a ON a.id = p.ambassador_id`;

interface PostRow {
  id: string;
  ambassador_id: string;
  ambassador_name: string;
  content: string;
  status: PostStatus;
  scheduled_at: Date | null;
  due_at: Date | null;
  timezone: string;
  attempts: number;
  external_id: string | null;
  published_at: Date | null;
  last_error_code: string | null;
  last_error_detail: string | null;
  created_at: Date;
  updated_at: Date;
  cursor_ts: string;
  throttled_until: string | null;
  throttle_reason: string | null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function toDto(r: PostRow): PostDto {
  return {
    id: r.id,
    ambassador_id: r.ambassador_id,
    ambassador_name: r.ambassador_name,
    content: r.content,
    status: r.status,
    scheduled_at: iso(r.scheduled_at),
    due_at: iso(r.due_at),
    timezone: r.timezone,
    attempts: r.attempts,
    external_id: r.external_id,
    published_at: iso(r.published_at),
    last_error: r.last_error_code ? { code: r.last_error_code, detail: r.last_error_detail } : null,
    ambassador_throttle:
      r.throttled_until && ["scheduled", "publishing"].includes(r.status)
        ? { reason: r.throttle_reason, until: r.throttled_until }
        : null,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  };
}

export const PostId = z.uuid();

/** Invalid ids are indistinguishable from other tenants' ids: both are "not found". */
export function parsePostId(raw: string): string {
  const r = PostId.safeParse(raw);
  if (!r.success) throw new ApiError(404, "post_not_found", "Post not found");
  return r.data;
}

async function fetchPost(tx: Tx, id: string, lock = false): Promise<PostRow | undefined> {
  // FOR UPDATE OF p: the worker claims with SKIP LOCKED, so it simply skips a row we are editing.
  const { rows } = await tx.query<PostRow>(`${SELECT_POST} WHERE p.id = $1 ${lock ? "FOR UPDATE OF p" : ""}`, [id]);
  return rows[0];
}

async function mustFetch(tx: Tx, id: string, lock = false): Promise<PostRow> {
  const row = await fetchPost(tx, id, lock);
  if (!row) throw new ApiError(404, "post_not_found", "Post not found");
  return row;
}

function assertEditable(row: PostRow): void {
  if (row.status === "published") throw new ApiError(409, "post_published", "Published posts cannot be changed");
  if (row.status === "publishing") {
    throw new ApiError(409, "post_publishing", "The post is being published right now; try again in a moment");
  }
  if (row.status === "cancelled") throw new ApiError(409, "post_cancelled", "The post was cancelled");
}

const ScheduleFields = {
  scheduled_at: z.string().optional(),
  scheduled_local: z.string().optional(),
  timezone: z.string().optional(),
};

export const CreatePostBody = z
  .object({
    content: z.string().trim().min(1).max(3000),
    ambassador_id: z.uuid().optional(),
    status: z.enum(["draft", "scheduled"]).default("scheduled"),
    ...ScheduleFields,
  })
  .strict();

export const UpdatePostBody = z
  .object({
    content: z.string().trim().min(1).max(3000).optional(),
    status: z.enum(["draft", "scheduled"]).optional(),
    ...ScheduleFields,
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "Nothing to update" });

const hasSchedule = (b: { scheduled_at?: string; scheduled_local?: string }) =>
  b.scheduled_at !== undefined || b.scheduled_local !== undefined;

export async function createPost(db: Db, ctx: TenantContext, input: z.infer<typeof CreatePostBody>): Promise<PostDto> {
  const timezone = input.timezone ?? DEFAULT_TZ;
  const schedule = input.status === "scheduled" || hasSchedule(input) ? resolveSchedule({ ...input, timezone }) : null;

  return withTenant(db, ctx, async (tx) => {
    // Default: the caller schedules for themselves. Any Embajador must be visible (same tenant).
    const ambassadorId = input.ambassador_id ?? ctx.profileId;
    const { rowCount } = await tx.query("SELECT 1 FROM ambassadors WHERE id = $1", [ambassadorId]);
    if (!rowCount) throw new ApiError(422, "unknown_ambassador", "Embajador not found in your tenant");

    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO posts (tenant_id, ambassador_id, content, status, scheduled_at, due_at, timezone, created_by)
       VALUES (app_current_tenant(), $1, $2, $3::post_status, $4::timestamptz,
               CASE WHEN $3::post_status = 'scheduled' THEN $4::timestamptz END, $5,
               NULLIF(current_setting('app.profile_id', true), '')::uuid)
       RETURNING id`,
      [ambassadorId, input.content, input.status, schedule?.instant ?? null, timezone],
    );
    return toDto(await mustFetch(tx, rows[0]!.id));
  });
}

export async function updatePost(
  db: Db,
  ctx: TenantContext,
  id: string,
  input: z.infer<typeof UpdatePostBody>,
): Promise<PostDto> {
  return withTenant(db, ctx, async (tx) => {
    const row = await mustFetch(tx, id, true);
    assertEditable(row);

    const timezone = input.timezone ?? row.timezone;
    let scheduledAt = row.scheduled_at;
    if (hasSchedule(input)) scheduledAt = resolveSchedule({ ...input, timezone }).instant;
    else if (input.timezone !== undefined && row.scheduled_at) {
      throw new ApiError(422, "missing_schedule", "Changing the timezone requires the new scheduled time");
    }

    // A failed post becomes scheduled again when it gets a new time (manual DLQ requeue).
    let status: PostStatus = input.status ?? row.status;
    if (row.status === "failed" && (hasSchedule(input) || input.status === "scheduled")) status = "scheduled";
    if (status === "scheduled" && !scheduledAt) {
      throw new ApiError(422, "missing_schedule", "A scheduled post needs scheduled_at or scheduled_local");
    }
    if (status === "scheduled" && !hasSchedule(input) && scheduledAt && scheduledAt.getTime() < Date.now() - 60_000) {
      throw new ApiError(422, "scheduled_in_past", "The current scheduled time is in the past: send a new one");
    }
    const requeue = row.status === "failed" && status === "scheduled";

    await tx.query(
      `UPDATE posts
          SET content = $2, status = $3::post_status, scheduled_at = $4::timestamptz, timezone = $5,
              due_at = CASE WHEN $3::post_status = 'scheduled' THEN $4::timestamptz END,
              attempts = CASE WHEN $6::boolean THEN 0 ELSE attempts END,
              last_error_code = CASE WHEN $6::boolean THEN NULL ELSE last_error_code END,
              last_error_detail = CASE WHEN $6::boolean THEN NULL ELSE last_error_detail END
        WHERE id = $1`,
      [id, input.content ?? row.content, status, scheduledAt, timezone, requeue],
    );
    return toDto(await mustFetch(tx, id));
  });
}

/** DELETE = cancel (soft). Idempotent: cancelling a cancelled post returns it as is. */
export async function cancelPost(db: Db, ctx: TenantContext, id: string): Promise<PostDto> {
  return withTenant(db, ctx, async (tx) => {
    const row = await mustFetch(tx, id, true);
    if (row.status === "cancelled") return toDto(row);
    assertEditable(row);
    await tx.query("UPDATE posts SET status = 'cancelled' WHERE id = $1", [id]);
    return toDto(await mustFetch(tx, id));
  });
}

export async function getPost(db: Db, ctx: TenantContext, id: string): Promise<PostDto> {
  return withTenant(db, ctx, async (tx) => toDto(await mustFetch(tx, id)));
}

/** Core of "publish now", run inside the idempotency transaction. */
export async function publishNowTx(tx: Tx, id: string): Promise<{ status: number; post: PostDto }> {
  const row = await mustFetch(tx, id, true);
  if (row.status === "published") throw new ApiError(409, "post_already_published", "The post is already published");
  if (row.status === "cancelled") throw new ApiError(409, "post_cancelled", "The post was cancelled");
  if (row.status === "publishing") return { status: 202, post: toDto(row) }; // already in flight

  // Due right now: the worker takes it on its next tick, still subject to rate limits and pacing
  // (publishing "now" must not become a way to burst an account).
  await tx.query(
    `UPDATE posts
        SET status = 'scheduled', scheduled_at = now(), due_at = now(),
            attempts = 0, last_error_code = NULL, last_error_detail = NULL
      WHERE id = $1`,
    [id],
  );
  return { status: 202, post: toDto(await mustFetch(tx, id)) };
}

export const ListQuery = z.object({
  status: z.enum(POST_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

function encodeCursor(row: PostRow): string {
  return Buffer.from(JSON.stringify([row.cursor_ts, row.id])).toString("base64url");
}

function decodeCursor(cursor: string): [string, string] {
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(v) && typeof v[0] === "string" && PostId.safeParse(v[1]).success && !Number.isNaN(Date.parse(v[0]))) {
      return [v[0], v[1]];
    }
  } catch {
    // fall through
  }
  throw new ApiError(400, "invalid_cursor", "Malformed cursor");
}

/**
 * Keyset pagination on (created_at DESC, id DESC), served by posts_tenant[_status]_created_idx.
 * The cursor carries created_at as Postgres text (microsecond precision; a JS Date would lose it
 * and skip/duplicate rows created in the same millisecond).
 */
export async function listPosts(
  db: Db,
  ctx: TenantContext,
  q: z.infer<typeof ListQuery>,
): Promise<{ data: PostDto[]; next_cursor: string | null }> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.status) {
    params.push(q.status);
    where.push(`p.status = $${params.length}`);
  }
  if (q.cursor) {
    const [ts, id] = decodeCursor(q.cursor);
    params.push(ts, id);
    where.push(`(p.created_at, p.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(q.limit + 1);
  const sql = `${SELECT_POST} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY p.created_at DESC, p.id DESC LIMIT $${params.length}`;

  return withTenant(db, ctx, async (tx) => {
    const { rows } = await tx.query<PostRow>(sql, params);
    const page = rows.slice(0, q.limit);
    return {
      data: page.map(toDto),
      next_cursor: rows.length > q.limit ? encodeCursor(page[page.length - 1]!) : null,
    };
  });
}

export async function listAmbassadors(db: Db, ctx: TenantContext) {
  return withTenant(db, ctx, async (tx) => {
    const { rows } = await tx.query(
      `SELECT ambassador_id AS id, display_name, due_now::int, in_flight::int, oldest_due_scheduled_at,
              CASE WHEN throttled_until > now() THEN throttled_until::text END AS throttled_until,
              throttle_reason, last_outcome, last_error_code, last_retry_after_sec, last_attempt_at
         FROM ambassador_queue_status ORDER BY display_name`,
    );
    return rows;
  });
}
