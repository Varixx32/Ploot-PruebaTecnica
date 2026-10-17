import { attachDatabasePool } from "@vercel/functions";
import { createPool, type Db } from "@ploot/db";
import { env } from "./env";

const globalForDb = globalThis as unknown as { plootDb?: Db };

/**
 * One small pool per server instance, reused across requests (and across HMR reloads in dev).
 * Connects as ploot_app_login: RLS-scoped, no access to the token vault.
 *
 * In production the URL points at a transaction-mode pooler (Neon/PgBouncer), so N serverless
 * instances x APP_DB_POOL_MAX client connections never reach Postgres' max_connections directly.
 */
export function db(): Db {
  if (!globalForDb.plootDb) {
    const pool = createPool({
      connectionString: env().databaseUrl(),
      max: env().dbPoolMax,
      applicationName: "app",
    });
    // Vercel Fluid compute: release idle connections before the instance is suspended.
    if (process.env.VERCEL) attachDatabasePool(pool);
    globalForDb.plootDb = pool;
  }
  return globalForDb.plootDb;
}
