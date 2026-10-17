import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAccounts } from "@ploot/provider-fixtures";
import { createPool, type Db } from "../src/pool.js";
import { seed } from "../src/dev/seed.js";
import { ownerUrl, secrets, testCipher } from "./support/env.js";

let owner: Db;
beforeAll(() => {
  owner = createPool({ connectionString: ownerUrl(), max: 1 });
});
afterAll(() => owner.end());

describe("seed", () => {
  it("is idempotent", async () => {
    expect(await seed(ownerUrl(), testCipher(), secrets().fixtureSecret)).toEqual({ tenants: 0, ambassadors: 0, tokens: 0, posts: 0 });
  });

  it("stores tokens encrypted and they decrypt to the provider's derived fixtures", async () => {
    const fixtures = loadAccounts(secrets().fixtureSecret);
    const { rows } = await owner.query(
      `SELECT a.provider_user_id, t.ambassador_id, t.access_token_enc, t.key_version
         FROM provider_tokens t JOIN ambassadors a ON a.id = t.ambassador_id`,
    );
    const cipher = testCipher();
    for (const r of rows) {
      const expected = fixtures.find((f) => f.provider_user_id === r.provider_user_id)!.access_token;
      expect(cipher.decrypt(r.access_token_enc, r.key_version, r.ambassador_id, "access_token")).toBe(expected);
    }
  });

  it("covers valid, expired and revoked tokens", async () => {
    const { rows } = await owner.query(
      `SELECT count(*) FILTER (WHERE status = 'valid' AND expires_at > now())::int AS valid,
              count(*) FILTER (WHERE status = 'valid' AND expires_at <= now())::int AS expired,
              count(*) FILTER (WHERE status = 'revoked')::int AS revoked
         FROM provider_tokens`,
    );
    expect(rows[0]).toEqual({ valid: 4, expired: 2, revoked: 1 });
  });
});
