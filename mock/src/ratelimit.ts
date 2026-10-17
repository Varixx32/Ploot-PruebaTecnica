export interface BucketSpec {
  capacity: number;
  refillPerSec: number;
}

/** Classic token bucket with an injected clock (no timers, testable without sleeping). */
export class TokenBucket {
  private tokens: number;
  private updatedAt: number;

  constructor(
    private readonly spec: BucketSpec,
    private readonly now: () => number,
  ) {
    this.tokens = spec.capacity;
    this.updatedAt = now();
  }

  private refill(): void {
    const t = this.now();
    const elapsedSec = (t - this.updatedAt) / 1000;
    this.tokens = Math.min(this.spec.capacity, this.tokens + elapsedSec * this.spec.refillPerSec);
    this.updatedAt = t;
  }

  available(): boolean {
    this.refill();
    return this.tokens >= 1;
  }

  take(): void {
    this.refill();
    this.tokens -= 1;
  }

  /** Whole seconds until one token is available (what goes into Retry-After). */
  retryAfterSec(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.max(1, Math.ceil((1 - this.tokens) / this.spec.refillPerSec));
  }
}

export interface AbuseSpec {
  /** Requests sent while already rate-limited, within the window, before the account gets restricted. */
  strikes: number;
  windowSec: number;
  restrictionSec: number;
}

export type Admission =
  | { ok: true }
  | { ok: false; reason: "rate_limited"; scope: "user" | "app"; retryAfterSec: number }
  | { ok: false; reason: "account_restricted"; retryAfterSec: number };

/**
 * Provider-side limits: one bucket per user (Embajador) and one per app shared by everybody.
 * Ignoring Retry-After on the user bucket earns strikes; too many => soft-ban, like a real network.
 */
export class RateLimiter {
  private userBuckets = new Map<string, TokenBucket>();
  private appBucket: TokenBucket;
  private strikes = new Map<string, number[]>();
  private restrictedUntil = new Map<string, number>();

  constructor(
    private readonly userSpec: BucketSpec,
    private readonly appSpec: BucketSpec,
    private readonly abuse: AbuseSpec,
    private readonly now: () => number,
  ) {
    this.appBucket = new TokenBucket(appSpec, now);
  }

  private userBucket(userId: string): TokenBucket {
    let bucket = this.userBuckets.get(userId);
    if (!bucket) {
      bucket = new TokenBucket(this.userSpec, this.now);
      this.userBuckets.set(userId, bucket);
    }
    return bucket;
  }

  private addStrike(userId: string): void {
    const t = this.now();
    const windowStart = t - this.abuse.windowSec * 1000;
    const recent = (this.strikes.get(userId) ?? []).filter((s) => s > windowStart);
    recent.push(t);
    this.strikes.set(userId, recent);
    if (recent.length >= this.abuse.strikes) {
      this.restrictedUntil.set(userId, t + this.abuse.restrictionSec * 1000);
      this.strikes.delete(userId);
    }
  }

  /** Decides and, only if admitted, consumes one token from both buckets. */
  admit(userId: string): Admission {
    const until = this.restrictedUntil.get(userId);
    if (until !== undefined) {
      if (until > this.now()) {
        return { ok: false, reason: "account_restricted", retryAfterSec: Math.ceil((until - this.now()) / 1000) };
      }
      this.restrictedUntil.delete(userId);
    }

    const user = this.userBucket(userId);
    if (!user.available()) {
      this.addStrike(userId);
      return { ok: false, reason: "rate_limited", scope: "user", retryAfterSec: user.retryAfterSec() };
    }
    if (!this.appBucket.available()) {
      return { ok: false, reason: "rate_limited", scope: "app", retryAfterSec: this.appBucket.retryAfterSec() };
    }
    user.take();
    this.appBucket.take();
    return { ok: true };
  }

  restrictedUsers(): { provider_user_id: string; restricted_until: string }[] {
    const t = this.now();
    return [...this.restrictedUntil]
      .filter(([, until]) => until > t)
      .map(([provider_user_id, until]) => ({ provider_user_id, restricted_until: new Date(until).toISOString() }));
  }

  reset(): void {
    this.userBuckets.clear();
    this.strikes.clear();
    this.restrictedUntil.clear();
    this.appBucket = new TokenBucket(this.appSpec, this.now);
  }
}
