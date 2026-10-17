import { randomBytes } from "node:crypto";
import pg from "pg";
import { TokenCipher, createPool, ensureLoginRoles, migrate, type Db } from "@ploot/db";
import { SEED_AMBASSADORS, SEED_TENANTS, seed } from "../../../packages/db/src/dev/seed.js";

export { SEED_AMBASSADORS, SEED_TENANTS };

const TEST_DB = "ploot_test_worker";
const WORKER_LOGIN = "ploot_worker_login";

function adminUrl(): string {
  if (process.env.TEST_ADMIN_DATABASE_URL) return process.env.TEST_ADMIN_DATABASE_URL;
  const { POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_PORT } = process.env;
  if (!POSTGRES_USER || !POSTGRES_PASSWORD) {
    throw new Error("Integration tests need TEST_ADMIN_DATABASE_URL or POSTGRES_* (run scripts/init-env.sh)");
  }
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

export interface TestDb {
  owner: Db;
  ownerUrl: string;
  workerUrl: string;
  tokenKeys: string;
  cipher: TokenCipher;
  /** Fresh tenants/Embajadores/tokens for a given mock, no posts. */
  reset: (fixtureSecret: string) => Promise<void>;
  close: () => Promise<void>;
}

/** Throwaway database with fresh random credentials, migrated once per test file. */
export async function setupTestDb(): Promise<TestDb> {
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  const ownerUrl = urlFor();
  const workerPassword = randomBytes(24).toString("hex");
  await migrate(ownerUrl);
  await ensureLoginRoles(ownerUrl, [
    { name: WORKER_LOGIN, password: workerPassword, memberOf: "ploot_worker", connectionLimit: 40, statementTimeout: "15s" },
  ]);
  const tokenKeys = `1:${randomBytes(32).toString("base64")}`;
  const cipher = TokenCipher.fromEnv(tokenKeys);
  const owner = createPool({ connectionString: ownerUrl, max: 3 });

  return {
    owner,
    ownerUrl,
    workerUrl: urlFor({ name: WORKER_LOGIN, password: workerPassword }),
    tokenKeys,
    cipher,
    reset: async (fixtureSecret) => {
      await owner.query("TRUNCATE tenants CASCADE");
      await owner.query(
        `UPDATE rate_buckets SET tokens = capacity, updated_at = now(), paused_until = '-infinity', pause_reason = NULL`,
      );
      await seed(ownerUrl, cipher, fixtureSecret);
      await owner.query("DELETE FROM posts");
    },
    close: () => owner.end(),
  };
}

export const amb = (name: string) => {
  const a = SEED_AMBASSADORS.find((x) => x.name === name);
  if (!a) throw new Error(`unknown seed ambassador ${name}`);
  return { id: a.id, tenantId: SEED_TENANTS[a.tenant], providerUserId: a.providerUserId };
};

/** Inserts scheduled posts due now (offsetSec < 0 = in the past). Returns their ids. */
export async function insertDuePosts(db: Db, ambassador: string, count: number, offsetSec = -1): Promise<string[]> {
  const a = amb(ambassador);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO posts (tenant_id, ambassador_id, content, status, scheduled_at, due_at)
     SELECT $1, $2, 'post ' || g || ' de ' || $3, 'scheduled',
            now() + make_interval(secs => $4), now() + make_interval(secs => $4)
       FROM generate_series(1, $5) g
     RETURNING id`,
    [a.tenantId, a.id, ambassador, offsetSec, count],
  );
  return rows.map((r) => r.id);
}

export async function waitFor<T>(
  probe: () => Promise<T>,
  done: (v: T) => boolean,
  { timeoutMs = 30_000, intervalMs = 50 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (done(v)) return v;
    if (Date.now() > deadline) throw new Error(`waitFor timed out; last value: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export async function statusCounts(db: Db): Promise<Record<string, number>> {
  const { rows } = await db.query<{ status: string; n: number }>(
    "SELECT status::text, count(*)::int AS n FROM posts GROUP BY status",
  );
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

export const pending = (c: Record<string, number>) => (c.scheduled ?? 0) + (c.publishing ?? 0);
