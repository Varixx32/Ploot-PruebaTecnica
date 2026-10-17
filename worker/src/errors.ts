/**
 * Typed error taxonomy. Codes are persisted in posts.last_error_code / publish_attempts.error_code
 * and shown in the UI, so they are part of the contract: add, never rename.
 */
export const ErrorCodes = {
  /** Grant revoked (or refresh rejected): unrecoverable until the Embajador re-authenticates. */
  TOKEN_REVOKED: "token_revoked",
  /** Provider rejected the content (422): retrying cannot help. */
  INVALID_CONTENT: "invalid_content",
  /** The request may have reached the provider but we never learnt the result. Not retried: a
   *  duplicate post on the Embajador's account is worse than a missed one. Needs a human. */
  OUTCOME_UNKNOWN: "outcome_unknown",
  /** 5xx from the provider; retried with backoff, terminal after max attempts. */
  PROVIDER_UNAVAILABLE: "provider_unavailable",
  /** Request never left (connection refused / DNS): safe to retry. */
  NETWORK_ERROR: "network_error",
  /** Token refresh hit a transient provider error: retried with backoff. */
  TOKEN_REFRESH_UNAVAILABLE: "token_refresh_unavailable",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/** Outcome of one provider call, persisted in publish_attempts.outcome. */
export type AttemptOutcome =
  | "published"
  | "rate_limited_user"
  | "rate_limited_app"
  | "account_restricted"
  | "token_expired"
  | "token_revoked"
  | "invalid_content"
  | "provider_error"
  | "network_error"
  | "outcome_unknown"
  | "lease_expired";

/** Why an Embajador's queue is paused (ambassadors.throttle_reason). */
export type ThrottleReason = "pacing" | "rate_limited" | "account_restricted" | "token_revoked";
