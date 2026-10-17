import { randomBytes } from "node:crypto";
import pg from "pg";
import { createPool, type Db } from "@ploot/db";
import { TokenCipher } from "../../../packages/db/src/crypto.js";
import { ensureLoginRoles, migrate } from "@ploot/db/admin";
import { SEED_AMBASSADORS, SEED_TENANTS, seed, seedUuid } from "../../../packages/db/src/dev/seed.js";
import { signDevJwt } from "../../../packages/db/src/dev/jwt.js";

export { SEED_AMBASSADORS, SEED_TENANTS, seedUuid };

const TEST_DB = "ploot_test_app";

function adminUrl(): string {
  if (process.env.TEST_ADMIN_DATABASE_URL) return process.env.TEST_ADMIN_DATABASE_URL;
  const { POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_PORT } = process.env;
  if (!POSTGRES_USER || !POSTGRES_PASSWORD) throw new Error("API tests need TEST_ADMIN_DATABASE_URL or POSTGRES_* (scripts/init-env.sh)");
  const u = new URL("postgres://localhost/postgres");
  u.port = POSTGRES_PORT ?? "5433";
  u.username = POSTGRES_USER;
  u.password = POSTGRES_PASSWORD;
  return u.toString();
}

function urlFor(user?: { name: string; password: string }): string {
  const u = new URL(adminUrl());
  u.pathname = `/${TEST_DB}`;
  if (user) {
    u.username = user.name;
    u.password = user.password;
  }
  return u.toString();
}

export interface ApiTestEnv {
  owner: Db;
  token: (tenant: keyof typeof SEED_TENANTS, ambassadorName: string) => Promise<string>;
  close: () => Promise<void>;
}

/**
 * Fresh DB + throwaway secrets; points the app (APP_DATABASE_URL / JWT_SECRET) at it. The app
 * connects as ploot_app_login, so RLS is in force exactly as in production.
 */
export async function setupApiEnv(): Promise<ApiTestEnv> {
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  const ownerUrl = urlFor();
  const appPassword = randomBytes(24).toString("hex");
  await migrate(ownerUrl);
  await ensureLoginRoles(ownerUrl, [
    { name: "ploot_app_login", password: appPassword, memberOf: "ploot_app", connectionLimit: 40, statementTimeout: "5s" },
  ]);
  await seed(ownerUrl, TokenCipher.fromEnv(`1:${randomBytes(32).toString("base64")}`), randomBytes(32).toString("hex"));

  const jwtSecret = randomBytes(32).toString("hex");
  process.env.APP_DATABASE_URL = urlFor({ name: "ploot_app_login", password: appPassword });
  process.env.JWT_SECRET = jwtSecret;
  process.env.APP_DB_POOL_MAX = "5";

  const owner = createPool({ connectionString: ownerUrl, max: 2 });
  return {
    owner,
    token: (tenant, name) => {
      const a = SEED_AMBASSADORS.find((x) => x.name === name && x.tenant === tenant);
      if (!a) throw new Error(`no ${name} in ${tenant}`);
      return signDevJwt(jwtSecret, { tenantId: SEED_TENANTS[tenant], profileId: a.id });
    },
    close: async () => {
      await owner.end();
      const { db } = await import("../../src/lib/db");
      await db().end();
      (globalThis as { plootDb?: unknown }).plootDb = undefined;
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (req: Request, ctx: { params: Promise<any> }) => Promise<Response>;

/** Invokes a Route Handler the way Next does. */
export async function call(
  handler: Handler,
  opts: { method: string; path: string; token?: string; body?: unknown; headers?: Record<string, string>; params?: Record<string, string> },
): Promise<{ status: number; body: any; headers: Headers }> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const req = new Request(`http://localhost${opts.path}`, {
    method: opts.method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const res = await handler(req, { params: Promise.resolve(opts.params ?? {}) });
  return { status: res.status, body: await res.json(), headers: res.headers };
}
