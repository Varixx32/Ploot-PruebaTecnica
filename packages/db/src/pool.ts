import pg from "pg";

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export interface PoolOptions {
  connectionString: string;
  /** Per-process cap. Serverless: keep tiny (1–2) and put a pooler in front. Worker: a handful. */
  max?: number;
  applicationName?: string;
}

/**
 * node-postgres only uses server-side prepared statements when a query is given a `name`.
 * We never name queries, so this works unchanged behind PgBouncer in transaction mode.
 */
export function createPool(opts: PoolOptions): Db {
  return new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    application_name: opts.applicationName,
  });
}

export async function withTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export interface TenantContext {
  tenantId: string;
  profileId: string;
}

/**
 * The only way the API touches tenant data: a transaction whose RLS context is the caller's
 * tenant. set_config(..., true) is transaction-local (SET LOCAL), so it never leaks to the next
 * borrower of the pooled connection, and it works behind a transaction-mode pooler.
 */
export async function withTenant<T>(db: Db, ctx: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withTransaction(db, async (tx) => {
    await tx.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.profile_id', $2, true)", [
      ctx.tenantId,
      ctx.profileId,
    ]);
    return fn(tx);
  });
}
