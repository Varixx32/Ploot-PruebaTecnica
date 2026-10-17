import type { FastifyReply, FastifyRequest } from "fastify";
import type { MockConfig } from "./config.js";
import type { MockDeps } from "./app.js";

const FORCEABLE = new Set([429, 500, 502, 503]);
const RANDOM_5XX = [500, 502, 503] as const;

/**
 * Header that lets tests/demos force a response deterministically
 * (e.g. `X-Mock-Force: 503`). Ignored unless it's a supported code.
 */
export function forcedStatus(req: FastifyRequest): number | undefined {
  const raw = req.headers["x-mock-force"];
  const code = Number(Array.isArray(raw) ? raw[0] : raw);
  return FORCEABLE.has(code) ? code : undefined;
}

export async function injectLatency(config: MockConfig, deps: MockDeps): Promise<void> {
  if (config.latencyMaxMs <= 0) return;
  await deps.sleep(Math.floor(deps.rng() * config.latencyMaxMs));
}

/** Rolls the dice for a random provider-side 5xx. Returns the status to send, if any. */
export function randomServerError(config: MockConfig, deps: MockDeps): number | undefined {
  if (deps.rng() >= config.errorRate5xx) return undefined;
  return RANDOM_5XX[Math.floor(deps.rng() * RANDOM_5XX.length)];
}

export function sendServerError(reply: FastifyReply, status: number) {
  return reply.code(status).send({ error: "provider_unavailable", status });
}
