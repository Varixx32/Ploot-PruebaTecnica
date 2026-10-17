import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;

export type TokenField = "access_token" | "refresh_token";

/**
 * Versioned AES-256-GCM keyring for the token vault.
 * Format: TOKEN_ENC_KEYS="1:<base64 32B>,2:<base64 32B>" — the highest version encrypts, all decrypt,
 * so rotation is: add a key, deploy, re-encrypt rows lazily on refresh, later drop the old key.
 * In production the key material would come from a KMS (envelope encryption), not a plain env var.
 */
export class TokenCipher {
  private readonly keys: Map<number, Buffer>;
  readonly activeVersion: number;

  constructor(keys: Map<number, Buffer>) {
    if (keys.size === 0) throw new Error("TokenCipher needs at least one key");
    for (const [v, k] of keys) {
      if (k.length !== 32) throw new Error(`Token key v${v} must be 32 bytes, got ${k.length}`);
    }
    this.keys = keys;
    this.activeVersion = Math.max(...keys.keys());
  }

  static fromEnv(raw: string | undefined): TokenCipher {
    if (!raw) throw new Error("TOKEN_ENC_KEYS is not set");
    const keys = new Map<number, Buffer>();
    for (const part of raw.split(",")) {
      const [v, b64] = part.trim().split(":");
      const version = Number(v);
      if (!Number.isInteger(version) || version < 1 || version > 32767 || !b64) {
        throw new Error("TOKEN_ENC_KEYS must look like '1:<base64>,2:<base64>'");
      }
      keys.set(version, Buffer.from(b64, "base64"));
    }
    return new TokenCipher(keys);
  }

  /** AAD binds the ciphertext to its row and column: a blob copied elsewhere won't decrypt. */
  private static aad(ambassadorId: string, field: TokenField): Buffer {
    return Buffer.from(`${ambassadorId}:${field}`);
  }

  encrypt(plaintext: string, ambassadorId: string, field: TokenField): { blob: Buffer; keyVersion: number } {
    const key = this.keys.get(this.activeVersion)!;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(TokenCipher.aad(ambassadorId, field));
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return { blob: Buffer.concat([iv, cipher.getAuthTag(), ct]), keyVersion: this.activeVersion };
  }

  decrypt(blob: Buffer, keyVersion: number, ambassadorId: string, field: TokenField): string {
    const key = this.keys.get(keyVersion);
    if (!key) throw new Error(`Unknown token key version ${keyVersion}`);
    const iv = blob.subarray(0, IV_BYTES);
    const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ct = blob.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(TokenCipher.aad(ambassadorId, field));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  }
}
