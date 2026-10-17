import type { FastifyInstance } from "fastify";
import type { MockConfig } from "../config.js";
import type { MockDeps } from "../app.js";
import type { TokenRegistry } from "../tokens.js";
import { forcedStatus, injectLatency, randomServerError, sendServerError } from "../chaos.js";

interface RefreshBody {
  refresh_token?: unknown;
}

export function registerOAuthRoutes(
  app: FastifyInstance,
  config: MockConfig,
  deps: MockDeps,
  tokens: TokenRegistry,
) {
  app.post<{ Body: RefreshBody }>("/provider/oauth/refresh", async (req, reply) => {
    await injectLatency(config, deps);

    // Transient failures on refresh are possible too: callers must not confuse them with revocation.
    const forced = forcedStatus(req);
    const failure = forced && forced >= 500 ? forced : randomServerError(config, deps);
    if (failure) return sendServerError(reply, failure);

    const refreshToken = req.body?.refresh_token;
    if (typeof refreshToken !== "string" || refreshToken === "") {
      return reply.code(400).send({ error: "invalid_request", error_description: "refresh_token required" });
    }

    const result = tokens.refreshGrant(refreshToken);
    if (!result.ok) {
      return reply.code(400).send({ error: result.error, error_description: result.description });
    }
    return reply.code(200).send({
      access_token: result.accessToken,
      refresh_token: result.refreshToken,
      token_type: "Bearer",
      expires_in: result.expiresIn,
    });
  });
}
