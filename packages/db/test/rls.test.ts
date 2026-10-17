import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createPool, withTenant, type Db } from "../src/pool.js";
import { SEED_AMBASSADORS, SEED_TENANTS, seedUuid } from "../src/dev/seed.js";
import { appUrl, ownerUrl, workerUrl } from "./support/env.js";

const ACME = { tenantId: SEED_TENANTS.acme, profileId: SEED_AMBASSADORS[0]!.id };
const GLOBEX_POST = seedUuid("diego-due");
const GLOBEX_AMBASSADOR = SEED_AMBASSADORS.find((a) => a.name === "Diego")!.id;
const ACME_AMBASSADOR = ACME.profileId;

let app: Db;
let worker: Db;
let owner: Db;

beforeAll(() => {
  app = createPool({ connectionString: appUrl(), max: 1 });
  worker = createPool({ connectionString: workerUrl(), max: 1 });
  owner = createPool({ connectionString: ownerUrl(), max: 1 });
});
afterAll(async () => {
  await Promise.all([app.end(), worker.end(), owner.end()]);
});

function pgError(err: unknown): pg.DatabaseError {
  expect(err).toBeInstanceOf(pg.DatabaseError);
  return err as pg.DatabaseError;
}

describe("tenant isolation enforced by Postgres (RLS), not by the route handler", () => {
  it("without a tenant context the app role sees nothing (fails closed)", async () => {
    const { rows } = await app.query("SELECT count(*)::int AS n FROM posts");
    expect(rows[0].n).toBe(0);
    const t = await app.query("SELECT count(*)::int AS n FROM tenants");
    expect(t.rows[0].n).toBe(0);
  });

  it("a tenant only sees its own rows, even with an unfiltered query", async () => {
    const tenants = await withTenant(app, ACME, async (tx) =>
      (await tx.query<{ tenant_id: string }>("SELECT DISTINCT tenant_id FROM posts")).rows.map((r) => r.tenant_id),
    );
    expect(tenants).toEqual([SEED_TENANTS.acme]);
  });

  it("cross-tenant read by id returns no row", async () => {
    const rows = await withTenant(app, ACME, async (tx) =>
      (await tx.query("SELECT * FROM posts WHERE id = $1", [GLOBEX_POST])).rows,
    );
    expect(rows).toHaveLength(0);
  });

  it("cross-tenant update/cancel affects zero rows and leaves the other tenant's post intact", async () => {
    const affected = await withTenant(app, ACME, async (tx) =>
      (await tx.query("UPDATE posts SET status = 'cancelled' WHERE id = $1", [GLOBEX_POST])).rowCount,
    );
    expect(affected).toBe(0);
    const { rows } = await owner.query("SELECT status FROM posts WHERE id = $1", [GLOBEX_POST]);
    expect(rows[0].status).toBe("scheduled");
  });

  it("inserting a row for another tenant is rejected by the RLS WITH CHECK", async () => {
    const err = await withTenant(app, ACME, (tx) =>
      tx.query(
        `INSERT INTO posts (tenant_id, ambassador_id, content, status) VALUES ($1, $2, 'x', 'draft')`,
        [SEED_TENANTS.globex, GLOBEX_AMBASSADOR],
      ),
    ).catch((e: unknown) => e);
    expect(pgError(err).message).toMatch(/row-level security/);
  });

  it("moving an own post to another tenant is rejected", async () => {
    const err = await withTenant(app, ACME, (tx) =>
      tx.query("UPDATE posts SET tenant_id = $1 WHERE id = $2", [SEED_TENANTS.globex, seedUuid("ana-draft")]),
    ).catch((e: unknown) => e);
    expect(pgError(err).message).toMatch(/row-level security/);
  });

  it("an own-tenant post cannot point at another tenant's Embajador (composite FK)", async () => {
    const err = await withTenant(app, ACME, (tx) =>
      tx.query(
        `INSERT INTO posts (tenant_id, ambassador_id, content, status) VALUES ($1, $2, 'x', 'draft')`,
        [SEED_TENANTS.acme, GLOBEX_AMBASSADOR],
      ),
    ).catch((e: unknown) => e);
    expect(pgError(err).code).toBe("23503"); // foreign_key_violation
  });

  it("own-tenant writes work", async () => {
    const id = await withTenant(app, ACME, async (tx) =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO posts (tenant_id, ambassador_id, content, status) VALUES ($1, $2, 'mío', 'draft') RETURNING id`,
          [SEED_TENANTS.acme, ACME_AMBASSADOR],
        )
      ).rows[0]!.id,
    );
    expect(id).toBeTruthy();
  });

  it("the tenant context is transaction-local: it does not leak to the next user of the connection", async () => {
    await withTenant(app, ACME, (tx) => tx.query("SELECT 1"));
    // Same single pooled connection, no context now.
    const { rows } = await app.query("SELECT count(*)::int AS n FROM posts");
    expect(rows[0].n).toBe(0);
  });

  it("the app role has no access to the token vault and cannot hard-delete posts", async () => {
    const tokens = await withTenant(app, ACME, (tx) => tx.query("SELECT * FROM provider_tokens")).catch(
      (e: unknown) => e,
    );
    expect(pgError(tokens).code).toBe("42501"); // insufficient_privilege
    const del = await withTenant(app, ACME, (tx) => tx.query("DELETE FROM posts")).catch((e: unknown) => e);
    expect(pgError(del).code).toBe("42501");
  });

  it("the queue-status view respects RLS for the app role", async () => {
    const tenants = await withTenant(app, ACME, async (tx) =>
      (await tx.query<{ tenant_id: string }>("SELECT DISTINCT tenant_id FROM ambassador_queue_status")).rows,
    );
    expect(tenants.map((r) => r.tenant_id)).toEqual([SEED_TENANTS.acme]);
  });

  it("at most one post per Embajador can be publishing (unique partial index)", async () => {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      const claim = (label: string) =>
        client.query(
          `UPDATE posts SET status = 'publishing', lease_owner = 'test', lease_expires_at = now() + interval '1 minute'
            WHERE id = $1`,
          [seedUuid(label)],
        );
      await claim("bruno-burst-1");
      const err = await claim("bruno-burst-2").catch((e: unknown) => e);
      expect(pgError(err).constraint).toBe("posts_one_publishing_per_ambassador");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("the worker role operates across tenants", async () => {
    const { rows } = await worker.query("SELECT count(DISTINCT tenant_id)::int AS n FROM posts");
    expect(rows[0].n).toBe(2);
  });
});
