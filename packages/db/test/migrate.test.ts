import { cpSync, mkdtempSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import pg from "pg";
import { MIGRATIONS_DIR, loadMigrations, migrate } from "../src/migrate.js";
import { recreateDatabase, urlFor } from "./support/env.js";

describe("migrator", () => {
  it("N concurrent runs apply each migration exactly once", async () => {
    await recreateDatabase("ploot_test_migrate_concurrent");
    const url = urlFor("ploot_test_migrate_concurrent");
    const results = await Promise.all(Array.from({ length: 5 }, () => migrate(url)));

    const applied = results.flatMap((r) => r.applied).sort();
    const expected = loadMigrations().map((m) => m.version);
    expect(applied).toEqual(expected);

    const client = new pg.Client({ connectionString: url });
    await client.connect();
    const { rows } = await client.query("SELECT count(*)::int AS n FROM schema_migrations");
    await client.end();
    expect(rows[0].n).toBe(expected.length);
  });

  it("refuses to run when an applied migration was edited", async () => {
    await recreateDatabase("ploot_test_migrate_checksum");
    const url = urlFor("ploot_test_migrate_checksum");
    const dir = mkdtempSync(join(tmpdir(), "ploot-migrations-"));
    cpSync(MIGRATIONS_DIR, dir, { recursive: true });
    await migrate(url, dir);

    appendFileSync(join(dir, "0001_schema.sql"), "\n-- edited after the fact\n");
    await expect(migrate(url, dir)).rejects.toThrow(/checksum mismatch/);
  });
});
