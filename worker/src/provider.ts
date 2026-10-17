import { parseRetryAfter } from "./backoff.js";

export type PublishResult =
  | { kind: "published"; externalId: string; status: 200 }
  | { kind: "rate_limited"; scope: "user" | "app"; retryAfterSec: number; status: 429 }
  | { kind: "account_restricted"; retryAfterSec: number; status: 403 }
  | { kind: "token_expired"; status: 401 }
  | { kind: "token_revoked"; status: 401 }
  | { kind: "invalid_content"; status: number }
  | { kind: "server_error"; status: number }
  /** sent=false: the request never left (safe to retry). sent=true: it may have been processed. */
  | { kind: "network_error"; sent: boolean; detail: string };

export type RefreshResult =
  | { kind: "refreshed"; accessToken: string; refreshToken: string; expiresInSec: number }
  | { kind: "invalid_grant"; detail: string }
  | { kind: "transient"; detail: string };

/** Errors raised before any byte reached the provider: retrying cannot duplicate anything. */
const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);

function classifyNetworkError(err: unknown): { sent: boolean; detail: string } {
  const e = err as {
    name?: string;
    message?: string;
    cause?: { code?: string; message?: string; errors?: { code?: string }[] };
  };
  const code = e.cause?.code;
  if (code && NOT_SENT_CODES.has(code)) return { sent: false, detail: code };
  // Happy-eyeballs (IPv4 + IPv6) failures arrive as an AggregateError: not sent only if all were.
  const codes = e.cause?.errors?.map((x) => x.code ?? "");
  if (codes?.length && codes.every((c) => NOT_SENT_CODES.has(c))) return { sent: false, detail: codes[0]! };
  // Timeouts, resets, half-closed sockets: the provider may have published already.
  return { sent: true, detail: code ?? e.name ?? e.message ?? "unknown" };
}

export interface ProviderClientOptions {
  baseUrl: string;
  timeoutMs: number;
  defaultRetryAfterSec: number;
}

/** HTTP client for the provider contract. Never throws: every outcome is a typed value. */
export class ProviderClient {
  constructor(private readonly opts: ProviderClientOptions) {}

  async publish(accessToken: string, text: string, clientRef: string): Promise<PublishResult> {
    let res: Response;
    try {
      res = await fetch(`${this.opts.baseUrl}/provider/publish`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          "x-client-ref": clientRef,
        },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (err) {
      return { kind: "network_error", ...classifyNetworkError(err) };
    }

    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const retryAfter = () => parseRetryAfter(res.headers.get("retry-after"), this.opts.defaultRetryAfterSec);

    if (res.status === 200 && typeof body.id === "string") {
      return { kind: "published", externalId: body.id, status: 200 };
    }
    if (res.status === 429) {
      const scope = res.headers.get("x-ratelimit-scope") === "app" ? "app" : "user";
      return { kind: "rate_limited", scope, retryAfterSec: retryAfter(), status: 429 };
    }
    if (res.status === 403 && body.error === "account_restricted") {
      return { kind: "account_restricted", retryAfterSec: retryAfter(), status: 403 };
    }
    if (res.status === 401) {
      // invalid_token = the provider no longer knows this token: as unrecoverable as a revocation.
      return body.error === "token_expired" ? { kind: "token_expired", status: 401 } : { kind: "token_revoked", status: 401 };
    }
    if (res.status === 422 || res.status === 400) {
      return { kind: "invalid_content", status: res.status };
    }
    // 5xx, or a 200 without an id (contract violation): treat as a provider failure.
    return { kind: "server_error", status: res.status };
  }

  async refresh(refreshToken: string): Promise<RefreshResult> {
    let res: Response;
    try {
      res = await fetch(`${this.opts.baseUrl}/provider/oauth/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken }),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (err) {
      return { kind: "transient", detail: classifyNetworkError(err).detail };
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (
      res.status === 200 &&
      typeof body.access_token === "string" &&
      typeof body.refresh_token === "string" &&
      typeof body.expires_in === "number"
    ) {
      return {
        kind: "refreshed",
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        expiresInSec: body.expires_in,
      };
    }
    if (res.status === 400 && body.error === "invalid_grant") {
      return { kind: "invalid_grant", detail: String(body.error_description ?? "invalid_grant") };
    }
    return { kind: "transient", detail: `http_${res.status}` };
  }
}
