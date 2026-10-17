// Plain ESM (no build step) so both the mock and the DB seed can consume it as-is.
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const MIN_SECRET_LENGTH = 32;

/** @returns {import("./index.js").FixtureIdentity[]} */
export function loadIdentities() {
  const raw = readFileSync(new URL("./accounts.json", import.meta.url), "utf8");
  return JSON.parse(raw).accounts;
}

/**
 * Initial OAuth pair of an identity, derived with HMAC-SHA256 from a secret held only in the
 * environment. The mock and the seed derive the same values; nothing usable lives in the repo.
 * @param {string} secret
 * @param {string} providerUserId
 */
export function deriveInitialTokens(secret, providerUserId) {
  if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`MOCK_FIXTURE_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  const derive = (kind) => createHmac("sha256", secret).update(`${kind}:${providerUserId}`).digest("hex").slice(0, 40);
  return { accessToken: `mock_at_${derive("access")}`, refreshToken: `mock_rt_${derive("refresh")}` };
}

/**
 * @param {string} secret
 * @returns {import("./index.js").FixtureAccount[]}
 */
export function loadAccounts(secret) {
  return loadIdentities().map((identity) => {
    const { accessToken, refreshToken } = deriveInitialTokens(secret, identity.provider_user_id);
    return { ...identity, access_token: accessToken, refresh_token: refreshToken };
  });
}
