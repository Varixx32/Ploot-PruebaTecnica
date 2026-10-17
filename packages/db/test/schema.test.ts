import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createPool, type Db } from "../src/pool.js";
import { SEED_AMBASSADORS, SEED_TENANTS } from "../src/dev/seed.js";
import { ownerUrl } from "./support/env.js";

let owner: Db;
beforeAll(() => {
  owner = createPool({ connectionString: ownerUrl(), max: 1 });
});
afterAll(() => owner.end());

const base = { tenant: SEED_TENANTS.acme, ambassador: SEED_AMBASSADORS[0]!.id };

/** Runs an insert inside a rolled-back transaction and returns the violated constraint, if any. */
async function violation(columns: string, values: string): Promise<string | undefined> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO posts (tenant_id, ambassador_id, content, ${columns}) VALUES ($1, $2, 'x', ${values})`,
      [base.tenant, base.ambassador],
    );
    return undefined;
  } catch (err) {
    return (err as pg.DatabaseError).constraint;
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

describe("state invariants are enforced by the schema", () => {
  it("scheduled requires scheduled_at and due_at", async () => {
    expect(await violation("status", "'scheduled'")).toBe("scheduled_has_times");
    expect(await violation("status, scheduled_at, due_at", "'scheduled', now(), now()")).toBeUndefined();
  });

  it("publishing requires a lease", async () => {
    expect(await violation("status, scheduled_at, due_at", "'publishing', now(), now()")).toBe("publishing_has_lease");
  });

  it("published requires external_id and published_at", async () => {
    expect(await violation("status", "'published'")).toBe("published_has_external_id");
  });

  it("failed requires a typed error code", async () => {
    expect(await violation("status", "'failed'")).toBe("failed_has_error");
    expect(await violation("status, last_error_code", "'failed', 'token_revoked'")).toBeUndefined();
  });

  it("the worker hot query uses the partial due index", async () => {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_seqscan = off");
      const { rows } = await client.query(
        "EXPLAIN SELECT id FROM posts WHERE status = 'scheduled' AND due_at <= now() ORDER BY due_at LIMIT 10",
      );
      expect(rows.map((r) => r["QUERY PLAN"]).join("\n")).toMatch(/posts_due_idx/);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
