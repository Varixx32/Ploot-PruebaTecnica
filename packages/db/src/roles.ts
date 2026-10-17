import pg from "pg";

export interface LoginRoleSpec {
  name: string;
  password: string;
  /** Group role created by migrations (ploot_app / ploot_worker). */
  memberOf: "ploot_app" | "ploot_worker";
  /** Hard cap so one workload can never starve the other of Postgres connections. */
  connectionLimit: number;
  /** Server-side guard against runaway queries (e.g. '5s' for the interactive API). */
  statementTimeout: string;
}

/**
 * Creates or updates login users for the runtime roles. Runs in the deploy/bootstrap step with
 * the owner connection; passwords come from the environment, never from migrations or the repo.
 */
export async function ensureLoginRoles(databaseUrl: string, specs: LoginRoleSpec[]): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const spec of specs) {
      const ident = client.escapeIdentifier(spec.name);
      const password = client.escapeLiteral(spec.password);
      const limit = Math.trunc(spec.connectionLimit);
      const { rowCount } = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [spec.name]);
      const verb = rowCount ? "ALTER" : "CREATE";
      // NOBYPASSRLS / NOSUPERUSER explicit: RLS must apply to these users.
      await client.query(
        `${verb} ROLE ${ident} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE ` +
          `CONNECTION LIMIT ${limit} PASSWORD ${password}`,
      );
      await client.query(`GRANT ${client.escapeIdentifier(spec.memberOf)} TO ${ident}`);
      await client.query(`ALTER ROLE ${ident} SET statement_timeout = ${client.escapeLiteral(spec.statementTimeout)}`);
      await client.query(`ALTER ROLE ${ident} SET idle_in_transaction_session_timeout = '10s'`);
      await client.query(`ALTER ROLE ${ident} SET timezone = 'UTC'`);
    }
  } finally {
    await client.end();
  }
}
