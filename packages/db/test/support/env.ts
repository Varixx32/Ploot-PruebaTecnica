import { inject } from "vitest";
import pg from "pg";
import { TokenCipher } from "../../src/crypto.js";

/** Secrets generated fresh by the global setup on every run and shared with the test files. */
export interface TestSecrets {
  appPassword: string;
  workerPassword: string;
  tokenKeys: string;
  fixtureSecret: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    secrets: TestSecrets;
  }
}

/** Admin connection to the compose Postgres, from the environment only. */
export function adminUrl(): string {
  if (process.env.TEST_ADMIN_DATABASE_URL) return process.env.TEST_ADMIN_DATABASE_URL;
  const { POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_PORT } = process.env;
  if (!POSTGRES_USER || !POSTGRES_PASSWORD) {
    throw new Error("DB tests need TEST_ADMIN_DATABASE_URL or POSTGRES_USER/POSTGRES_PASSWORD (run scripts/init-env.sh)");
  }
  const u = new URL("postgres://localhost/postgres");
  u.port = POSTGRES_PORT ?? "5433";
  u.username = POSTGRES_USER;
  u.password = POSTGRES_PASSWORD;
  return u.toString();
}

export const TEST_DB = "ploot_test";
export const APP_LOGIN = "ploot_app_login";
export const WORKER_LOGIN = "ploot_worker_login";

export const secrets = (): TestSecrets => inject("secrets");
export const testCipher = (keys = secrets().tokenKeys) => TokenCipher.fromEnv(keys);

export function urlFor(database: string, user?: { name: string; password: string }): string {
  const u = new URL(adminUrl());
  u.pathname = `/${database}`;
  if (user) {
    u.username = user.name;
    u.password = user.password;
  }
  return u.toString();
}

export const ownerUrl = () => urlFor(TEST_DB);
export const appUrl = () => urlFor(TEST_DB, { name: APP_LOGIN, password: secrets().appPassword });
export const workerUrl = () => urlFor(TEST_DB, { name: WORKER_LOGIN, password: secrets().workerPassword });

export async function recreateDatabase(name: string): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(name)} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(name)}`);
  } finally {
    await admin.end();
  }
}
