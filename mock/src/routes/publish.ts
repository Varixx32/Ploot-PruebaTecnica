import type { FastifyInstance } from "fastify";
import type { MockConfig } from "../config.js";
import type { MockDeps } from "../app.js";
import type { TokenRegistry } from "../tokens.js";
import type { PublishLedger } from "../ledger.js";
import type { RateLimiter } from "../ratelimit.js";
import { forcedStatus, injectLatency, randomServerError, sendServerError } from "../chaos.js";

const MAX_TEXT_LENGTH = 3000;

interface PublishBody {
  text?: unknown;
}

function bearer(header: string | undefined): string | undefined {
  const match = header?.match(/^Bearer\s+(\S+)$/i);
  return match?.[1];
}

export function registerPublishRoutes(
  app: FastifyInstance,
  config: MockConfig,
  deps: MockDeps,
  tokens: TokenRegistry,
  ledger: PublishLedger,
  limiter: RateLimiter,
) {
  app.post<{ Body: PublishBody }>("/provider/publish", async (req, reply) => {
    await injectLatency(config, deps);

    const token = bearer(req.headers.authorization);
    if (!token) {
      return reply.code(401).send({ error: "invalid_token", error_description: "missing bearer token" });
    }
    const auth = tokens.authenticate(token);
    if (!auth.ok) {
      return reply.code(401).send({ error: auth.error });
    }

    const forced = forcedStatus(req);
    if (forced === 429) {
      return reply
        .code(429)
        .header("retry-after", String(config.forcedRetryAfterSec))
        .header("x-ratelimit-scope", "user")
        .send({ error: "rate_limited", scope: "user", retry_after: config.forcedRetryAfterSec });
    }

    const admission = limiter.admit(auth.userId);
    if (!admission.ok) {
      if (admission.reason === "account_restricted") {
        return reply
          .code(403)
          .header("retry-after", String(admission.retryAfterSec))
          .send({ error: "account_restricted", retry_after: admission.retryAfterSec });
      }
      return reply
        .code(429)
        .header("retry-after", String(admission.retryAfterSec))
        .header("x-ratelimit-scope", admission.scope)
        .send({ error: "rate_limited", scope: admission.scope, retry_after: admission.retryAfterSec });
    }

    // Assumption: a 5xx means the post was NOT published (no ambiguous "failed after commit").
    const failure = forced && forced >= 500 ? forced : randomServerError(config, deps);
    if (failure) return sendServerError(reply, failure);

    const text = req.body?.text;
    if (typeof text !== "string" || text.trim() === "" || text.length > MAX_TEXT_LENGTH) {
      return reply
        .code(422)
        .send({ error: "invalid_content", error_description: `text must be 1..${MAX_TEXT_LENGTH} chars` });
    }

    const rawRef = req.headers["x-client-ref"];
    const clientRef = (Array.isArray(rawRef) ? rawRef[0] : rawRef) ?? null;
    const rec = ledger.record(auth.userId, clientRef, text);
    return reply.code(200).send({ id: rec.external_id, published_at: rec.published_at });
  });
}
