import { randomBytes } from "node:crypto";
import { loadAccounts, type FixtureAccount } from "@ploot/provider-fixtures";

export type AuthResult =
  | { ok: true; userId: string }
  | { ok: false; error: "invalid_token" | "token_expired" | "token_revoked" };

export type RefreshResult =
  | { ok: true; accessToken: string; refreshToken: string; expiresIn: number }
  | { ok: false; error: "invalid_grant"; description: string };

interface AccessEntry {
  userId: string;
  expiresAt: number;
}

/** Fixture tokens in state "valid" live this long from boot, so the demo doesn't need a refresh right away. */
const FIXTURE_VALID_TTL_MS = 24 * 60 * 60 * 1000;
/** Fixture tokens in state "expired" expired this long before boot. */
const FIXTURE_EXPIRED_AGO_MS = 60 * 60 * 1000;

/**
 * In-memory OAuth state of the provider. Volatile by design: a mock restart
 * resets it to the fixtures (documented assumption).
 */
export class TokenRegistry {
  private access = new Map<string, AccessEntry>();
  /** Current (non-rotated) refresh token -> userId. */
  private refresh = new Map<string, string>();
  /** Refresh tokens already rotated out -> userId, to report reuse explicitly. */
  private rotatedRefresh = new Map<string, string>();
  private revokedUsers = new Set<string>();
  private knownUsers = new Set<string>();

  constructor(
    private readonly fixtures: FixtureAccount[],
    private readonly accessTtlSec: number,
    private readonly now: () => number,
  ) {
    this.reset();
  }

  static fromSecret(secret: string, accessTtlSec: number, now: () => number): TokenRegistry {
    return new TokenRegistry(loadAccounts(secret), accessTtlSec, now);
  }

  reset(): void {
    this.access.clear();
    this.refresh.clear();
    this.rotatedRefresh.clear();
    this.revokedUsers.clear();
    this.knownUsers.clear();

    const bootAt = this.now();
    for (const acc of this.fixtures) {
      this.knownUsers.add(acc.provider_user_id);
      const expiresAt =
        acc.state === "expired" ? bootAt - FIXTURE_EXPIRED_AGO_MS : bootAt + FIXTURE_VALID_TTL_MS;
      this.access.set(acc.access_token, { userId: acc.provider_user_id, expiresAt });
      this.refresh.set(acc.refresh_token, acc.provider_user_id);
      if (acc.state === "revoked") this.revokedUsers.add(acc.provider_user_id);
    }
  }

  authenticate(accessToken: string): AuthResult {
    const entry = this.access.get(accessToken);
    if (!entry) return { ok: false, error: "invalid_token" };
    // Revocation wins over expiry: a revoked grant is unrecoverable, an expired one isn't.
    if (this.revokedUsers.has(entry.userId)) return { ok: false, error: "token_revoked" };
    if (entry.expiresAt <= this.now()) return { ok: false, error: "token_expired" };
    return { ok: true, userId: entry.userId };
  }

  refreshGrant(refreshToken: string): RefreshResult {
    const userId = this.refresh.get(refreshToken);
    if (!userId) {
      const description = this.rotatedRefresh.has(refreshToken)
        ? "refresh_token_reused"
        : "unknown_refresh_token";
      return { ok: false, error: "invalid_grant", description };
    }
    if (this.revokedUsers.has(userId)) {
      return { ok: false, error: "invalid_grant", description: "grant_revoked" };
    }

    // Rotate: the old refresh token stops working and previous access tokens are invalidated.
    this.refresh.delete(refreshToken);
    this.rotatedRefresh.set(refreshToken, userId);
    for (const [token, entry] of this.access) {
      if (entry.userId === userId) this.access.delete(token);
    }

    const accessToken = `mock_at_${randomBytes(16).toString("hex")}`;
    const newRefresh = `mock_rt_${randomBytes(16).toString("hex")}`;
    this.access.set(accessToken, { userId, expiresAt: this.now() + this.accessTtlSec * 1000 });
    this.refresh.set(newRefresh, userId);
    return { ok: true, accessToken, refreshToken: newRefresh, expiresIn: this.accessTtlSec };
  }

  revokeUser(userId: string): boolean {
    if (!this.knownUsers.has(userId)) return false;
    this.revokedUsers.add(userId);
    return true;
  }

  snapshot() {
    return [...this.knownUsers].map((userId) => ({
      provider_user_id: userId,
      revoked: this.revokedUsers.has(userId),
      active_access_tokens: [...this.access.values()].filter(
        (e) => e.userId === userId && e.expiresAt > this.now(),
      ).length,
    }));
  }
}
