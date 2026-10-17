import { describe, expect, it } from "vitest";
import { decide, decideTokenFailure, type DecisionContext } from "../src/decide.js";

const ctx = (attempts = 1, over: Partial<DecisionContext> = {}): DecisionContext => ({
  attempts,
  maxAttempts: 5,
  backoff: { baseMs: 1000, maxMs: 60_000 },
  ambassadorMinIntervalSec: 25,
  rng: () => 0.5,
  ...over,
});

describe("decide()", () => {
  it("published: stores the external id and paces the Embajador", () => {
    expect(decide({ kind: "published", externalId: "ext_1", status: 200 }, ctx())).toEqual({
      outcome: "published",
      post: { kind: "published", externalId: "ext_1" },
      throttle: { untilSec: 25, reason: "pacing", extendOnly: true },
    });
  });

  it("429 user: head of queue kept, attempt refunded, Embajador waits Retry-After", () => {
    const d = decide({ kind: "rate_limited", scope: "user", retryAfterSec: 20, status: 429 }, ctx(3));
    expect(d.post).toMatchObject({ kind: "requeue", delayMs: null, refundAttempt: true, errorCode: "rate_limited" });
    expect(d.throttle).toEqual({ untilSec: 20, reason: "rate_limited" });
    expect(d.pauseAppSec).toBeUndefined();
  });

  it("429 app: pauses every worker, not just this Embajador", () => {
    const d = decide({ kind: "rate_limited", scope: "app", retryAfterSec: 7, status: 429 }, ctx());
    expect(d.pauseAppSec).toBe(7);
    expect(d.throttle).toBeUndefined();
    expect(d.post).toMatchObject({ kind: "requeue", delayMs: null, refundAttempt: true });
  });

  it("429 never fails a post, even on its last attempt", () => {
    const d = decide({ kind: "rate_limited", scope: "user", retryAfterSec: 20, status: 429 }, ctx(5));
    expect(d.post.kind).toBe("requeue");
  });

  it("403 account_restricted: queue paused, post untouched", () => {
    const d = decide({ kind: "account_restricted", retryAfterSec: 300, status: 403 }, ctx());
    expect(d.throttle).toEqual({ untilSec: 300, reason: "account_restricted" });
    expect(d.post).toMatchObject({ kind: "requeue", delayMs: null, refundAttempt: true });
  });

  it("revoked token: typed failure, no retries, Embajador paused until re-auth", () => {
    const d = decide({ kind: "token_revoked", status: 401 }, ctx(1));
    expect(d.post).toMatchObject({ kind: "fail", errorCode: "token_revoked" });
    expect(d.throttle).toEqual({ untilSec: "infinity", reason: "token_revoked" });
    expect(d.revokeToken).toBe(true);
  });

  it("expired token at the provider: refresh next time, same queue position", () => {
    const d = decide({ kind: "token_expired", status: 401 }, ctx(1));
    expect(d.markTokenExpired).toBe(true);
    expect(d.post).toEqual({ kind: "requeue", delayMs: null, refundAttempt: false });
  });

  it("5xx: exponential backoff with jitter, then failed (DLQ) at max attempts", () => {
    const retry = decide({ kind: "server_error", status: 503 }, ctx(3));
    expect(retry.post).toMatchObject({ kind: "requeue", delayMs: 2000, errorCode: "provider_unavailable" }); // 0.5 * 4000
    const last = decide({ kind: "server_error", status: 503 }, ctx(5));
    expect(last.post).toMatchObject({ kind: "fail", errorCode: "provider_unavailable" });
  });

  it("422: fails immediately", () => {
    expect(decide({ kind: "invalid_content", status: 422 }, ctx()).post).toMatchObject({ kind: "fail", errorCode: "invalid_content" });
  });

  it("network error before sending: retried", () => {
    const d = decide({ kind: "network_error", sent: false, detail: "ECONNREFUSED" }, ctx(1));
    expect(d.post).toMatchObject({ kind: "requeue", errorCode: "network_error" });
  });

  it("ambiguous network error (timeout): outcome_unknown, never retried", () => {
    const d = decide({ kind: "network_error", sent: true, detail: "TimeoutError" }, ctx(1));
    expect(d.post).toMatchObject({ kind: "fail", errorCode: "outcome_unknown" });
  });

  it("token refresh failures: revoked fails, transient backs off", () => {
    expect(decideTokenFailure({ kind: "revoked", detail: "refresh_rejected:grant_revoked" }, ctx()).post).toMatchObject({
      kind: "fail",
      errorCode: "token_revoked",
    });
    expect(decideTokenFailure({ kind: "transient", detail: "http_503" }, ctx()).post).toMatchObject({
      kind: "requeue",
      errorCode: "token_refresh_unavailable",
    });
  });
});
