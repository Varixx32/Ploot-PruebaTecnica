import { backoffMs } from "./backoff.js";
import { ErrorCodes, type AttemptOutcome, type ThrottleReason } from "./errors.js";
import type { PublishResult } from "./provider.js";
import type { PostTransition } from "./repo.js";

export interface DecisionContext {
  /** Attempt number of this try (already incremented by the claim). */
  attempts: number;
  maxAttempts: number;
  backoff: { baseMs: number; maxMs: number };
  ambassadorMinIntervalSec: number;
  rng?: () => number;
}

export interface Decision {
  post: PostTransition;
  outcome: AttemptOutcome;
  errorCode?: string;
  retryAfterSec?: number;
  throttle?: { untilSec: number | "infinity"; reason: ThrottleReason; extendOnly?: boolean };
  pauseAppSec?: number;
  revokeToken?: boolean;
  markTokenExpired?: boolean;
}

function retryOrGiveUp(ctx: DecisionContext, code: string, detail: string, outcome: AttemptOutcome): Decision {
  if (ctx.attempts >= ctx.maxAttempts) {
    return { outcome, errorCode: code, post: { kind: "fail", errorCode: code, detail: `gave up after ${ctx.attempts} attempts: ${detail}` } };
  }
  const delayMs = backoffMs(ctx.attempts, ctx.backoff.baseMs, ctx.backoff.maxMs, ctx.rng);
  return { outcome, errorCode: code, post: { kind: "requeue", delayMs, refundAttempt: false, errorCode: code, detail } };
}

const revoked = (detail: string): Decision => ({
  outcome: "token_revoked",
  errorCode: ErrorCodes.TOKEN_REVOKED,
  post: { kind: "fail", errorCode: ErrorCodes.TOKEN_REVOKED, detail },
  // Pause the whole queue of this Embajador until re-auth: its other posts wait, they don't fail.
  throttle: { untilSec: "infinity", reason: "token_revoked" },
  revokeToken: true,
});

/**
 * Pure mapping from a provider result to what must happen. Rules:
 *  - throttling signals (429/403) are not the post's fault: requeue WITHOUT advancing the head of the
 *    Embajador's queue and refund the attempt; the Embajador (or the whole app) waits Retry-After;
 *  - unrecoverable errors fail immediately with a typed code and burn no retries;
 *  - transient errors back off with full jitter up to maxAttempts (then `failed` = DLQ);
 *  - an ambiguous network error may have published: fail as outcome_unknown, never retry.
 */
export function decide(result: PublishResult, ctx: DecisionContext): Decision {
  switch (result.kind) {
    case "published":
      return {
        outcome: "published",
        post: { kind: "published", externalId: result.externalId },
        throttle:
          ctx.ambassadorMinIntervalSec > 0
            ? { untilSec: ctx.ambassadorMinIntervalSec, reason: "pacing", extendOnly: true }
            : undefined,
      };

    case "rate_limited": {
      const detail = `waiting Retry-After ${result.retryAfterSec}s (provider ${result.scope} limit)`;
      const post: PostTransition = {
        kind: "requeue",
        delayMs: null,
        refundAttempt: true,
        errorCode: ErrorCodes.RATE_LIMITED,
        detail,
      };
      return result.scope === "app"
        ? { outcome: "rate_limited_app", retryAfterSec: result.retryAfterSec, post, pauseAppSec: result.retryAfterSec }
        : {
            outcome: "rate_limited_user",
            retryAfterSec: result.retryAfterSec,
            post,
            throttle: { untilSec: result.retryAfterSec, reason: "rate_limited" },
          };
    }

    case "account_restricted":
      return {
        outcome: "account_restricted",
        retryAfterSec: result.retryAfterSec,
        post: {
          kind: "requeue",
          delayMs: null,
          refundAttempt: true,
          errorCode: ErrorCodes.ACCOUNT_RESTRICTED,
          detail: `account restricted by the provider, paused ${result.retryAfterSec}s`,
        },
        throttle: { untilSec: result.retryAfterSec, reason: "account_restricted" },
      };

    case "token_expired": {
      // Expired between our check and the call: refresh on the next attempt, same queue position.
      // It still counts as an attempt, so a provider that keeps saying "expired" is bounded.
      const code = ErrorCodes.TOKEN_REFRESH_UNAVAILABLE;
      if (ctx.attempts >= ctx.maxAttempts) {
        return { ...retryOrGiveUp(ctx, code, "token keeps expiring at the provider", "token_expired"), markTokenExpired: true };
      }
      return {
        outcome: "token_expired",
        post: { kind: "requeue", delayMs: null, refundAttempt: false },
        markTokenExpired: true,
      };
    }

    case "token_revoked":
      return revoked("provider rejected the access token (revoked)");

    case "invalid_content":
      return {
        outcome: "invalid_content",
        errorCode: ErrorCodes.INVALID_CONTENT,
        post: { kind: "fail", errorCode: ErrorCodes.INVALID_CONTENT, detail: `provider rejected the content (${result.status})` },
      };

    case "server_error":
      return retryOrGiveUp(ctx, ErrorCodes.PROVIDER_UNAVAILABLE, `provider answered ${result.status}`, "provider_error");

    case "network_error":
      if (!result.sent) {
        return retryOrGiveUp(ctx, ErrorCodes.NETWORK_ERROR, `request not sent (${result.detail})`, "network_error");
      }
      return {
        outcome: "outcome_unknown",
        errorCode: ErrorCodes.OUTCOME_UNKNOWN,
        post: {
          kind: "fail",
          errorCode: ErrorCodes.OUTCOME_UNKNOWN,
          detail: `no response from the provider (${result.detail}); not retried to avoid a duplicate post`,
        },
      };
  }
}

/** Token could not be obtained before publishing. */
export function decideTokenFailure(
  failure: { kind: "revoked" | "transient"; detail: string },
  ctx: DecisionContext,
): Decision {
  if (failure.kind === "revoked") return revoked(failure.detail);
  return retryOrGiveUp(ctx, ErrorCodes.TOKEN_REFRESH_UNAVAILABLE, `token refresh failed (${failure.detail})`, "provider_error");
}
