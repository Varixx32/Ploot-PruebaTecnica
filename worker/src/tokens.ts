import type { Db, TokenCipher } from "@ploot/db";
import type { ProviderClient } from "./provider.js";

export type AccessTokenResult =
  | { kind: "ok"; accessToken: string; refreshed: boolean }
  | { kind: "revoked"; detail: string }
  | { kind: "transient"; detail: string };

interface TokenRow {
  access_token_enc: Buffer;
  refresh_token_enc: Buffer;
  key_version: number;
  status: "valid" | "revoked";
  fresh: boolean;
}

/**
 * Returns a usable access token for an Embajador, refreshing it first if it expires within
 * `skewSec`. The token row is locked (FOR UPDATE) for the whole refresh: refresh tokens rotate,
 * so two concurrent refreshes would make the loser look revoked. After acquiring the lock the
 * expiry is re-checked, because another worker may have just refreshed it.
 *
 * The provider call happens inside the transaction; its timeout is kept below the role's
 * idle_in_transaction_session_timeout (10 s) so Postgres never kills a legitimate refresh.
 */
export async function getAccessToken(
  db: Db,
  cipher: TokenCipher,
  provider: ProviderClient,
  ambassadorId: string,
  skewSec: number,
): Promise<AccessTokenResult> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const { rows: [row] } = await client.query<TokenRow>(
      `SELECT access_token_enc, refresh_token_enc, key_version, status,
              expires_at > now() + make_interval(secs => $2) AS fresh
         FROM provider_tokens WHERE ambassador_id = $1 FOR UPDATE`,
      [ambassadorId, skewSec],
    );
    if (!row) {
      await client.query("ROLLBACK");
      return { kind: "revoked", detail: "no_token_on_file" };
    }
    if (row.status === "revoked") {
      await client.query("ROLLBACK");
      return { kind: "revoked", detail: "token_marked_revoked" };
    }
    if (row.fresh) {
      await client.query("COMMIT");
      return {
        kind: "ok",
        accessToken: cipher.decrypt(row.access_token_enc, row.key_version, ambassadorId, "access_token"),
        refreshed: false,
      };
    }

    const refreshToken = cipher.decrypt(row.refresh_token_enc, row.key_version, ambassadorId, "refresh_token");
    const result = await provider.refresh(refreshToken);

    if (result.kind === "refreshed") {
      // Re-encrypt with the active key: key rotation happens lazily on every refresh.
      const at = cipher.encrypt(result.accessToken, ambassadorId, "access_token");
      const rt = cipher.encrypt(result.refreshToken, ambassadorId, "refresh_token");
      await client.query(
        `UPDATE provider_tokens
            SET access_token_enc = $2, refresh_token_enc = $3, key_version = $4,
                expires_at = now() + make_interval(secs => $5), refreshed_at = now()
          WHERE ambassador_id = $1`,
        [ambassadorId, at.blob, rt.blob, at.keyVersion, result.expiresInSec],
      );
      await client.query("COMMIT");
      return { kind: "ok", accessToken: result.accessToken, refreshed: true };
    }
    if (result.kind === "invalid_grant") {
      await client.query(
        "UPDATE provider_tokens SET status = 'revoked', revoked_at = now() WHERE ambassador_id = $1",
        [ambassadorId],
      );
      await client.query("COMMIT");
      return { kind: "revoked", detail: `refresh_rejected:${result.detail}` };
    }
    await client.query("ROLLBACK");
    return { kind: "transient", detail: result.detail };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** After a 401 token_expired (clock skew / early expiry): make the next attempt refresh first. */
export async function markTokenExpired(db: Db, ambassadorId: string): Promise<void> {
  await db.query("UPDATE provider_tokens SET expires_at = LEAST(expires_at, now()) WHERE ambassador_id = $1", [
    ambassadorId,
  ]);
}
