import { randomBytes } from "node:crypto";
import type { TestProject } from "vitest/node";
import { TokenCipher } from "../../src/crypto.js";
import { migrate } from "../../src/migrate.js";
import { ensureLoginRoles } from "../../src/roles.js";
import { seed } from "../../src/dev/seed.js";
import { APP_LOGIN, TEST_DB, WORKER_LOGIN, recreateDatabase, urlFor, type TestSecrets } from "./env.js";

/** One fresh, migrated, seeded database shared by the suite, with throwaway secrets. */
export default async function setup(project: TestProject): Promise<void> {
  const secrets: TestSecrets = {
    appPassword: randomBytes(24).toString("hex"),
    workerPassword: randomBytes(24).toString("hex"),
    tokenKeys: `1:${randomBytes(32).toString("base64")}`,
    fixtureSecret: randomBytes(32).toString("hex"),
  };
  project.provide("secrets", secrets);

  const owner = urlFor(TEST_DB);
  await recreateDatabase(TEST_DB);
  await migrate(owner);
  await ensureLoginRoles(owner, [
    { name: APP_LOGIN, password: secrets.appPassword, memberOf: "ploot_app", connectionLimit: 20, statementTimeout: "5s" },
    { name: WORKER_LOGIN, password: secrets.workerPassword, memberOf: "ploot_worker", connectionLimit: 20, statementTimeout: "15s" },
  ]);
  await seed(owner, TokenCipher.fromEnv(secrets.tokenKeys), secrets.fixtureSecret);
}
