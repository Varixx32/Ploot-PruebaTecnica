import { createPool, type Db } from "@ploot/db";
import { env } from "./env";

const globalForDb = globalThis as unknown as { plootDb?: Db };

/**
 * One small pool per server instance, reused across requests (and across HMR reloads in dev).
 * Connects as ploot_app_login: RLS-scoped, no access to the token vault.
 */
export function db(): Db {
  if (!globalForDb.plootDb) {
    globalForDb.plootDb = createPool({
      connectionString: env().databaseUrl(),
      max: env().dbPoolMax,
      applicationName: "app",
    });
  }
  return globalForDb.plootDb;
}
