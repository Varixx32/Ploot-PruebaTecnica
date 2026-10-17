# Ploot · Scheduler de publicación

Prueba técnica de backend: scheduler que publica en nombre de los Embajadores contra un
proveedor externo. Next.js (Route Handlers) + worker separado + PostgreSQL + mock del proveedor.

**URL pública:** _pendiente_

## Levantarlo en local

Requisitos: Docker con Compose v2 y `openssl`.

```bash
git clone https://github.com/Varixx32/Ploot-PruebaTecnica.git
cd Ploot-PruebaTecnica
./scripts/init-env.sh        # crea .env con todos los secretos generados al azar
docker compose up --build
```

El repositorio no contiene ningún secreto: el compose se niega a arrancar sin `.env`.

| Servicio | URL local | Qué es |
|----------|-----------|--------|
| postgres | `localhost:5433` | Postgres 16 |
| setup    | — | Un solo uso: migraciones + usuarios de BD + seed (idempotente) |
| mock     | `http://localhost:4000` | Proveedor simulado ([contrato](mock/README.md)) |
| worker   | — (2 réplicas) | Publicador de larga vida, fuera de Next.js ([diseño](worker/README.md)) |

La configuración no secreta (latencias del mock, rate limits…) se ajusta en `.env`.

### Datos de demo y JWT de prueba

El seed crea 2 tenants (`acme`, `globex`), 7 Embajadores con tokens en los tres estados
(válido, expirado, revocado) y posts en todos los estados. Al terminar, `setup` imprime un
JWT por tenant:

```bash
docker compose logs setup
```

JWT para cualquier otra combinación (requiere `npm install`; lee `JWT_SECRET` de `.env`):

```bash
npm run cli -w @ploot/db -- jwt --tenant <tenant_uuid> --profile <ambassador_uuid>
```

### ¿Por qué va atrasado un Embajador?

```bash
docker compose exec worker node dist/why.js Bruno     # nombre, provider_user_id o uuid
docker compose logs -f worker                          # logs JSON: post_id, outcome, retry_after, lag
docker compose exec worker wget -qO- localhost:9464/metrics
```

## Tests

Los tests de base de datos corren contra el Postgres del compose (credenciales de `.env`;
el resto de secretos de test se generan al azar en cada ejecución):

```bash
docker compose up -d postgres
npm install
npm test
```

| Qué se prueba | Dónde |
|---------------|-------|
| N réplicas sin doble publicación; crash a mitad (fallo inyectado y `SIGKILL` real) | `worker/test/replicas.test.ts` |
| 429 (por Embajador y por app), pacing, tokens expirados/revocados, 5xx hasta DLQ | `worker/test/behaviour.test.ts` |
| Claim: cabeza de cola, reparto justo por tenant, caps, `SKIP LOCKED` | `worker/test/claim.test.ts` |
| Petición cross-tenant rechazada a nivel SQL (RLS) | `packages/db/test/rls.test.ts` |
| Invariantes de estado en el esquema | `packages/db/test/schema.test.ts` |
| Cifrado de tokens (AES-GCM, rotación de clave) | `packages/db/test/crypto.test.ts` |
| Migraciones concurrentes aplicadas una sola vez | `packages/db/test/migrate.test.ts` |
| Contrato del mock (429/Retry-After, tokens, soft-ban) | `mock/test/` |

## Estructura

```
worker/                     worker de publicación (proceso de larga vida)
mock/                       mock del proveedor (servicio HTTP independiente)
packages/db/                esquema SQL, migrador, acceso por tenant, cifrado de tokens, seed, CLI
packages/provider-fixtures/ identidades del proveedor compartidas por mock y seed
scripts/init-env.sh         genera el .env local
docker-compose.yml          stack local completo
```
