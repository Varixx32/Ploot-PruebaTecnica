import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

export const MIGRATIONS_DIR = new URL("../migrations", import.meta.url).pathname;

/** Arbitrary constant: every migrator instance contends on the same advisory lock. */
const MIGRATION_LOCK_KEY = 727_001;

export interface MigrationFile {
  version: string;
  sql: string;
  checksum: string;
}

export function loadMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_[\w-]+\.sql$/.test(f))
    .sort()
    .map((file) => {
      const sql = readFileSync(join(dir, file), "utf8");
      return { version: file.replace(/\.sql$/, ""), sql, checksum: createHash("sha256").update(sql).digest("hex") };
    });
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

/**
 * Applies pending migrations, each in its own transaction.
 *
 * Safe to run from N instances at once: a session-level advisory lock serialises them and the
 * losers find nothing pending. Needs a direct (session) connection, not a transaction-mode pooler.
 * Already-applied migrations are verified by checksum: editing one is an error, write a new one.
 */
export async function migrate(databaseUrl: string, dir = MIGRATIONS_DIR): Promise<MigrateResult> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const { rows } = await client.query<{ version: string; checksum: string }>(
      "SELECT version, checksum FROM schema_migrations",
    );
    const done = new Map(rows.map((r) => [r.version, r.checksum]));
    const result: MigrateResult = { applied: [], skipped: [] };

    for (const m of loadMigrations(dir)) {
      const appliedChecksum = done.get(m.version);
      if (appliedChecksum !== undefined) {
        if (appliedChecksum !== m.checksum) {
          throw new Error(`Migration ${m.version} was modified after being applied (checksum mismatch)`);
        }
        result.skipped.push(m.version);
        continue;
      }
      try {
        await client.query("BEGIN");
        await client.query(m.sql);
        await client.query("INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)", [
          m.version,
          m.checksum,
        ]);
        await client.query("COMMIT");
        result.applied.push(m.version);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${m.version} failed: ${(err as Error).message}`, { cause: err });
      }
    }
    return result;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {});
    await client.end();
  }
}
