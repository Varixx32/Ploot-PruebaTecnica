import { createHash } from "node:crypto";
import { withTenant, type Db, type TenantContext, type Tx } from "@ploot/db";
import { ApiError } from "./http";

export interface StoredResponse {
  status: number;
  body: unknown;
  replayed: boolean;
}

const KEY_RE = /^[\x21-\x7e]{1,255}$/;

export function parseIdempotencyKey(req: Request): string {
  const key = req.headers.get("idempotency-key");
  if (!key) throw new ApiError(400, "idempotency_key_required", "Idempotency-Key header is required");
  if (!KEY_RE.test(key)) throw new ApiError(400, "invalid_idempotency_key", "Idempotency-Key must be 1-255 visible ASCII chars");
  return key;
}

/**
 * Runs `fn` at most once per (tenant, key). The key row is inserted in the SAME transaction as the
 * state change and holds the response:
 *  - first request: inserts the key, runs fn, stores the response, commits both atomically;
 *  - retry with the same request: replays the stored response (no second state change);
 *  - same key, different request: 422 (client bug, never silently ignored);
 *  - concurrent duplicate: its INSERT waits on the first one's uncommitted key row, then sees the
 *    conflict and replays the committed response.
 * Deterministic errors (4xx) are stored and replayed too; unexpected errors roll back the key so
 * the client can retry safely with the same key.
 */
export async function withIdempotency(
  db: Db,
  ctx: TenantContext,
  key: string,
  fingerprintSource: string,
  postId: string,
  fn: (tx: Tx) => Promise<{ status: number; body: unknown }>,
): Promise<StoredResponse> {
  const fingerprint = createHash("sha256").update(fingerprintSource).digest("hex");

  return withTenant(db, ctx, async (tx) => {
    const inserted = await tx.query(
      `INSERT INTO idempotency_keys (tenant_id, key, request_fingerprint)
       VALUES (app_current_tenant(), $1, $2)
       ON CONFLICT (tenant_id, key) DO NOTHING
       RETURNING key`,
      [key, fingerprint],
    );

    if (!inserted.rowCount) {
      const { rows: [prev] } = await tx.query<{ request_fingerprint: string; response_status: number | null; response_body: unknown }>(
        "SELECT request_fingerprint, response_status, response_body FROM idempotency_keys WHERE key = $1",
        [key],
      );
      if (!prev || prev.request_fingerprint !== fingerprint) {
        throw new ApiError(422, "idempotency_key_reused", "This Idempotency-Key was used for a different request");
      }
      if (prev.response_status === null) {
        throw new ApiError(409, "idempotency_in_progress", "A request with this Idempotency-Key is still running");
      }
      return { status: prev.response_status, body: prev.response_body, replayed: true };
    }

    let result: { status: number; body: unknown };
    try {
      result = await fn(tx);
    } catch (err) {
      if (!(err instanceof ApiError) || err.status >= 500) throw err;
      result = { status: err.status, body: { error: { code: err.code, message: err.message, details: err.details } } };
    }
    await tx.query(
      `UPDATE idempotency_keys
          SET response_status = $2, response_body = $3,
              post_id = (SELECT id FROM posts WHERE id = $4)
        WHERE key = $1`,
      [key, result.status, JSON.stringify(result.body), postId],
    );
    return { ...result, replayed: false };
  });
}
