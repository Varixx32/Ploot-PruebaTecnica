import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TokenCipher } from "../src/crypto.js";

const key = () => randomBytes(32);
const AMB = "a1000000-0000-4000-8000-000000000001";

describe("TokenCipher", () => {
  it("round-trips and never stores plaintext", () => {
    const c = new TokenCipher(new Map([[1, key()]]));
    const { blob, keyVersion } = c.encrypt("mock_at_secret", AMB, "access_token");
    expect(blob.includes(Buffer.from("mock_at_secret"))).toBe(false);
    expect(c.decrypt(blob, keyVersion, AMB, "access_token")).toBe("mock_at_secret");
  });

  it("uses a fresh IV every time", () => {
    const c = new TokenCipher(new Map([[1, key()]]));
    expect(c.encrypt("t", AMB, "access_token").blob.equals(c.encrypt("t", AMB, "access_token").blob)).toBe(false);
  });

  it("rejects tampered ciphertext", () => {
    const c = new TokenCipher(new Map([[1, key()]]));
    const { blob } = c.encrypt("token", AMB, "access_token");
    blob[blob.length - 1]! ^= 0xff;
    expect(() => c.decrypt(blob, 1, AMB, "access_token")).toThrow();
  });

  it("a blob copied to another Embajador or column does not decrypt (AAD)", () => {
    const c = new TokenCipher(new Map([[1, key()]]));
    const { blob } = c.encrypt("token", AMB, "access_token");
    expect(() => c.decrypt(blob, 1, "a2000000-0000-4000-8000-000000000004", "access_token")).toThrow();
    expect(() => c.decrypt(blob, 1, AMB, "refresh_token")).toThrow();
  });

  it("supports rotation: new key encrypts, old key still decrypts", () => {
    const k1 = key();
    const old = new TokenCipher(new Map([[1, k1]]));
    const legacy = old.encrypt("legacy", AMB, "refresh_token");

    const rotated = new TokenCipher(new Map([[1, k1], [2, key()]]));
    expect(rotated.activeVersion).toBe(2);
    expect(rotated.decrypt(legacy.blob, legacy.keyVersion, AMB, "refresh_token")).toBe("legacy");
    expect(rotated.encrypt("new", AMB, "refresh_token").keyVersion).toBe(2);
  });

  it("validates key configuration", () => {
    expect(() => TokenCipher.fromEnv(undefined)).toThrow(/not set/);
    expect(() => TokenCipher.fromEnv("garbage")).toThrow();
    expect(() => TokenCipher.fromEnv(`1:${randomBytes(16).toString("base64")}`)).toThrow(/32 bytes/);
  });
});
