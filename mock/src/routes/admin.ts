import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { MockConfig } from "../config.js";
import type { TokenRegistry } from "../tokens.js";
import type { PublishLedger } from "../ledger.js";
import type { RateLimiter } from "../ratelimit.js";

function keyMatches(expected: string, given: string | string[] | undefined): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Test/demo-only introspection and fault injection. Not part of the provider contract. */
export function registerAdminRoutes(
  app: FastifyInstance,
  config: MockConfig,
  tokens: TokenRegistry,
  ledger: PublishLedger,
  limiter: RateLimiter,
) {
  if (!config.adminEnabled) return;

  void app.register(
    async (admin) => {
      if (config.adminKey) {
        const key = config.adminKey;
        admin.addHook("onRequest", async (req, reply) => {
          if (!keyMatches(key, req.headers["x-admin-key"])) {
            return reply.code(401).send({ error: "admin_key_required" });
          }
        });
      }

      admin.get("/publishes", async () => ({
        total: ledger.all().length,
        duplicates: ledger.duplicates(),
        records: ledger.all(),
      }));

      admin.get("/tokens", async () => tokens.snapshot());

      admin.get("/restrictions", async () => limiter.restrictedUsers());

      admin.post<{ Params: { providerUserId: string } }>(
        "/tokens/:providerUserId/revoke",
        async (req, reply) => {
          if (!tokens.revokeUser(req.params.providerUserId)) {
            return reply.code(404).send({ error: "unknown_user" });
          }
          return { revoked: req.params.providerUserId };
        },
      );

      admin.post("/reset", async () => {
        tokens.reset();
        ledger.reset();
        limiter.reset();
        return { reset: true };
      });
    },
    { prefix: "/__admin" },
  );
}
