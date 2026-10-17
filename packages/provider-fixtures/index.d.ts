export type FixtureState = "valid" | "expired" | "revoked";

export interface FixtureIdentity {
  provider_user_id: string;
  state: FixtureState;
}

export interface FixtureAccount extends FixtureIdentity {
  access_token: string;
  refresh_token: string;
}

export declare function loadIdentities(): FixtureIdentity[];
export declare function deriveInitialTokens(
  secret: string,
  providerUserId: string,
): { accessToken: string; refreshToken: string };
export declare function loadAccounts(secret: string): FixtureAccount[];
