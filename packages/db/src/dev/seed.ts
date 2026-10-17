import { createHash } from "node:crypto";
import pg from "pg";
import { loadAccounts } from "@ploot/provider-fixtures";
import type { TokenCipher } from "../crypto.js";

export const SEED_TENANTS = {
  acme: "11111111-1111-4111-8111-111111111111",
  globex: "22222222-2222-4222-8222-222222222222",
} as const;

interface SeedAmbassador {
  id: string;
  tenant: keyof typeof SEED_TENANTS;
  name: string;
  providerUserId: string;
  /** The provider revoked it AND we already know (marked revoked in our vault). */
  knownRevoked?: boolean;
}

export const SEED_AMBASSADORS: SeedAmbassador[] = [
  { id: "a1000000-0000-4000-8000-000000000001", tenant: "acme", name: "Ana", providerUserId: "pu_acme_ana" },
  { id: "a1000000-0000-4000-8000-000000000002", tenant: "acme", name: "Bruno", providerUserId: "pu_acme_bruno" },
  { id: "a1000000-0000-4000-8000-000000000003", tenant: "acme", name: "Carla", providerUserId: "pu_acme_carla" },
  { id: "a2000000-0000-4000-8000-000000000004", tenant: "globex", name: "Diego", providerUserId: "pu_globex_diego" },
  { id: "a2000000-0000-4000-8000-000000000005", tenant: "globex", name: "Elena", providerUserId: "pu_globex_elena" },
  // Revoked at the provider, still "valid" in our vault: discovered at publish time.
  { id: "a2000000-0000-4000-8000-000000000006", tenant: "globex", name: "Fede", providerUserId: "pu_globex_fede" },
  {
    id: "a2000000-0000-4000-8000-000000000007",
    tenant: "globex",
    name: "Gina",
    providerUserId: "pu_globex_gina",
    knownRevoked: true,
  },
];

/** Deterministic UUID from a label, so re-running the seed is a no-op (ON CONFLICT DO NOTHING). */
export function seedUuid(label: string): string {
  const h = createHash("sha256").update(`ploot-seed:${label}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

type PostSeed = {
  label: string;
  ambassador: string;
  status: "draft" | "scheduled" | "published" | "failed" | "cancelled";
  /** Offset from seed time, in minutes. */
  inMin?: number;
  content: string;
  errorCode?: string;
  attempts?: number;
};

function postSeeds(): PostSeed[] {
  const [ana, bruno, carla, diego, elena, fede, gina] = SEED_AMBASSADORS.map((a) => a.id) as [
    string, string, string, string, string, string, string,
  ];
  const burst = Array.from({ length: 6 }, (_, i): PostSeed => ({
    label: `bruno-burst-${i + 1}`,
    ambassador: bruno,
    status: "scheduled",
    inMin: 0,
    content: `Hilo sobre prospección basada en señales (${i + 1}/6)`,
  }));
  return [
    { label: "ana-published", ambassador: ana, status: "published", inMin: -2 * 24 * 60, content: "Lo que aprendimos cerrando 30 reuniones en un trimestre" },
    { label: "ana-due", ambassador: ana, status: "scheduled", inMin: -1, content: "Tres señales de compra que casi todos ignoran" },
    { label: "ana-soon", ambassador: ana, status: "scheduled", inMin: 5, content: "Por qué dejamos el outbound frío" },
    { label: "ana-later", ambassador: ana, status: "scheduled", inMin: 3 * 24 * 60, content: "Checklist para tu primer mes como SDR" },
    { label: "ana-draft", ambassador: ana, status: "draft", content: "Borrador: ideas para el post del lunes" },
    // Burst on one Embajador: must be paced by the per-user limit, not retried in a storm.
    ...burst,
    // Expired token: the worker has to refresh before publishing.
    { label: "carla-due", ambassador: carla, status: "scheduled", inMin: 0, content: "Cómo preparo una primera llamada en 10 minutos" },
    { label: "diego-due", ambassador: diego, status: "scheduled", inMin: 0, content: "El CRM no es la fuente de verdad, la conversación sí" },
    { label: "diego-failed", ambassador: diego, status: "failed", inMin: -60, attempts: 5, errorCode: "provider_unavailable", content: "Post que agotó reintentos por 5xx" },
    { label: "diego-cancelled", ambassador: diego, status: "cancelled", inMin: 120, content: "Post cancelado por el usuario" },
    { label: "elena-due", ambassador: elena, status: "scheduled", inMin: 1, content: "Qué mido cada lunes en mi pipeline" },
    // Revoked at the provider but unknown to us: must fail typed without burning retries.
    { label: "fede-due", ambassador: fede, status: "scheduled", inMin: 0, content: "Este post no debería salir: token revocado" },
    { label: "gina-failed", ambassador: gina, status: "failed", inMin: -30, attempts: 1, errorCode: "token_revoked", content: "Falló por token revocado" },
  ];
}

export interface SeedResult {
  tenants: number;
  ambassadors: number;
  tokens: number;
  posts: number;
}

/**
 * Loads demo data as the owner (bypasses RLS on purpose). Idempotent: fixed ids + ON CONFLICT
 * DO NOTHING, so `docker compose up` can run it on every start.
 */
export async function seed(databaseUrl: string, cipher: TokenCipher, fixtureSecret: string): Promise<SeedResult> {
  // Same derivation as the mock: the initial provider tokens only exist in memory.
  const fixtures = loadAccounts(fixtureSecret);
  const byUser = new Map(fixtures.map((f) => [f.provider_user_id, f]));
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const result: SeedResult = { tenants: 0, ambassadors: 0, tokens: 0, posts: 0 };
  try {
    await client.query("BEGIN");
    for (const [name, id] of Object.entries(SEED_TENANTS)) {
      const r = await client.query("INSERT INTO tenants (id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING", [id, name]);
      result.tenants += r.rowCount ?? 0;
    }

    for (const a of SEED_AMBASSADORS) {
      const tenantId = SEED_TENANTS[a.tenant];
      const r = await client.query(
        `INSERT INTO ambassadors (id, tenant_id, display_name, provider_user_id)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [a.id, tenantId, a.name, a.providerUserId],
      );
      result.ambassadors += r.rowCount ?? 0;

      const fx = byUser.get(a.providerUserId);
      if (!fx) throw new Error(`No fixture for ${a.providerUserId}`);
      const at = cipher.encrypt(fx.access_token, a.id, "access_token");
      const rt = cipher.encrypt(fx.refresh_token, a.id, "refresh_token");
      const expiresSql = fx.state === "expired" ? "now() - interval '1 hour'" : "now() + interval '24 hours'";
      const t = await client.query(
        `INSERT INTO provider_tokens
           (ambassador_id, tenant_id, access_token_enc, refresh_token_enc, key_version, expires_at, status, revoked_at)
         VALUES ($1, $2, $3, $4, $5, ${expiresSql}, $6, $7)
         ON CONFLICT DO NOTHING`,
        [a.id, tenantId, at.blob, rt.blob, at.keyVersion, a.knownRevoked ? "revoked" : "valid", a.knownRevoked ? new Date() : null],
      );
      result.tokens += t.rowCount ?? 0;
    }

    const tenantOf = new Map(SEED_AMBASSADORS.map((a) => [a.id, SEED_TENANTS[a.tenant]]));
    for (const p of postSeeds()) {
      const when = p.inMin === undefined ? null : `now() + make_interval(mins => ${Math.trunc(p.inMin)})`;
      const scheduled = when ?? "NULL";
      const due = p.status === "scheduled" ? scheduled : "NULL";
      const r = await client.query(
        `INSERT INTO posts (id, tenant_id, ambassador_id, content, status, scheduled_at, due_at, attempts,
                            external_id, published_at, last_error_code, created_by)
         VALUES ($1, $2, $3, $4, $5, ${scheduled}, ${due}, $6, $7, ${p.status === "published" ? scheduled : "NULL"}, $8, $3)
         ON CONFLICT DO NOTHING`,
        [
          seedUuid(p.label),
          tenantOf.get(p.ambassador),
          p.ambassador,
          p.content,
          p.status,
          p.attempts ?? (p.status === "published" ? 1 : 0),
          p.status === "published" ? `ext_seed_${p.label}` : null,
          p.errorCode ?? null,
        ],
      );
      result.posts += r.rowCount ?? 0;
    }
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}
