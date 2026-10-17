#!/usr/bin/env node
import { parseArgs } from "node:util";
import { TokenCipher } from "./crypto.js";
import { migrate } from "./migrate.js";
import { ensureLoginRoles, type LoginRoleSpec } from "./roles.js";
import { signDevJwt } from "./dev/jwt.js";
import { SEED_AMBASSADORS, SEED_TENANTS, seed } from "./dev/seed.js";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function loginRoles(): LoginRoleSpec[] {
  return [
    {
      name: process.env.APP_DB_USER ?? "ploot_app_login",
      password: env("APP_DB_PASSWORD"),
      memberOf: "ploot_app",
      connectionLimit: Number(process.env.APP_DB_CONN_LIMIT ?? 40),
      statementTimeout: process.env.APP_DB_STATEMENT_TIMEOUT ?? "3s",
    },
    {
      name: process.env.WORKER_DB_USER ?? "ploot_worker_login",
      password: env("WORKER_DB_PASSWORD"),
      memberOf: "ploot_worker",
      connectionLimit: Number(process.env.WORKER_DB_CONN_LIMIT ?? 20),
      statementTimeout: process.env.WORKER_DB_STATEMENT_TIMEOUT ?? "15s",
    },
  ];
}

async function demoJwts(): Promise<void> {
  const secret = env("JWT_SECRET");
  const ana = SEED_AMBASSADORS.find((a) => a.name === "Ana")!;
  const diego = SEED_AMBASSADORS.find((a) => a.name === "Diego")!;
  console.log("\nDemo JWTs (dev only):");
  console.log(`  acme   / Ana   : ${await signDevJwt(secret, { tenantId: SEED_TENANTS.acme, profileId: ana.id })}`);
  console.log(`  globex / Diego : ${await signDevJwt(secret, { tenantId: SEED_TENANTS.globex, profileId: diego.id })}`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const databaseUrl = () => env("DATABASE_URL");

  switch (command) {
    case "migrate": {
      const r = await migrate(databaseUrl());
      console.log(`migrations applied=[${r.applied.join(", ")}] already=${r.skipped.length}`);
      break;
    }
    case "roles":
      await ensureLoginRoles(databaseUrl(), loginRoles());
      console.log("login roles ensured");
      break;
    case "seed": {
      const cipher = TokenCipher.fromEnv(process.env.TOKEN_ENC_KEYS);
      const r = await seed(databaseUrl(), cipher, env("MOCK_FIXTURE_SECRET"));
      console.log(`seed inserted tenants=${r.tenants} ambassadors=${r.ambassadors} tokens=${r.tokens} posts=${r.posts}`);
      break;
    }
    case "setup": {
      const m = await migrate(databaseUrl());
      console.log(`migrations applied=[${m.applied.join(", ")}] already=${m.skipped.length}`);
      await ensureLoginRoles(databaseUrl(), loginRoles());
      console.log("login roles ensured");
      const cipher = TokenCipher.fromEnv(process.env.TOKEN_ENC_KEYS);
      const s = await seed(databaseUrl(), cipher, env("MOCK_FIXTURE_SECRET"));
      console.log(`seed inserted tenants=${s.tenants} ambassadors=${s.ambassadors} tokens=${s.tokens} posts=${s.posts}`);
      if (process.env.JWT_SECRET) await demoJwts();
      break;
    }
    case "jwt": {
      const { values } = parseArgs({
        args: rest,
        options: { tenant: { type: "string" }, profile: { type: "string" }, ttl: { type: "string" } },
      });
      if (!values.tenant || !values.profile) {
        throw new Error("usage: jwt --tenant <uuid> --profile <uuid> [--ttl <seconds>]");
      }
      const ttl = values.ttl ? Number(values.ttl) : undefined;
      console.log(await signDevJwt(env("JWT_SECRET"), { tenantId: values.tenant, profileId: values.profile }, ttl));
      break;
    }
    default:
      console.error("usage: ploot-db <migrate|roles|seed|setup|jwt>");
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
