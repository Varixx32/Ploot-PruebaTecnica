# Ploot · Scheduler de publicación

Prueba técnica de backend: scheduler que publica en nombre de los Embajadores contra un
proveedor externo. Next.js (Route Handlers) + worker separado + PostgreSQL + mock del proveedor.

**URL pública:** https://ploot-pruebatecnica-app.vercel.app (botones «Entrar como acme / globex») · Despliegue: Vercel (app) + Neon (Postgres) + Railway (worker y mock), todo en la UE — ver [infra/](infra/README.md)

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
| app      | `http://localhost:3000` | API Next.js + UI de demo (botones de login de demo) |
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

### API

Todas las rutas requieren `Authorization: Bearer <JWT>` con `tenant_id` + `profile_id`.

| Método y ruta | Qué hace |
|---------------|----------|
| `POST /api/v1/posts` | Crea (`status`: `draft` \| `scheduled`). Hora como `scheduled_at` (ISO con offset) o `scheduled_local` + `timezone` (IANA, defecto `Europe/Madrid`) |
| `PATCH /api/v1/posts/:id` | Edita contenido/horario. `409` si está publicado o publicándose. Dar hora nueva a un `failed` lo reencola |
| `DELETE /api/v1/posts/:id` | Cancela (idempotente). `409` si está publicado o publicándose |
| `POST /api/v1/posts/:id/publish` | Publicación inmediata. Requiere `Idempotency-Key`; los reintentos devuelven la misma respuesta (`Idempotent-Replayed: true`) |
| `GET /api/v1/posts?status=&limit=&cursor=` | Listado paginado por cursor, del más reciente al más antiguo |
| `GET /api/v1/posts/:id` | Detalle, con el motivo de espera o el error tipado |
| `GET /api/v1/ambassadors` | Embajadores del tenant con su estado de cola |

Errores: `{ "error": { "code": "...", "message": "..." } }` con códigos estables
(`post_not_found`, `post_published`, `nonexistent_local_time`, `idempotency_key_reused`…).

```bash
TOKEN=$(curl -s -XPOST localhost:3000/api/demo/login -d '{"tenant":"acme"}' | jq -r .token)
curl -s -XPOST localhost:3000/api/v1/posts -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"content":"Hola","scheduled_local":"2026-12-01T09:00","timezone":"Europe/Madrid"}'
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
| Petición cross-tenant rechazada a nivel SQL (RLS), en BD y a través de la API | `packages/db/test/rls.test.ts`, `app/test/api.test.ts` |
| Idempotencia de `/publish` (reintento, concurrencia, clave reutilizada) | `app/test/api.test.ts` |
| DST `Europe/Madrid` (cambio de hora, hora inexistente, hora ambigua) | `app/test/time.test.ts` |
| Invariantes de estado en el esquema | `packages/db/test/schema.test.ts` |
| Cifrado de tokens (AES-GCM, rotación de clave) | `packages/db/test/crypto.test.ts` |
| Migraciones concurrentes aplicadas una sola vez | `packages/db/test/migrate.test.ts` |
| Contrato del mock (429/Retry-After, tokens, soft-ban) | `mock/test/` |

## Estructura

```
app/                        API Next.js (Route Handlers) + UI de demo
worker/                     worker de publicación (proceso de larga vida)
mock/                       mock del proveedor (servicio HTTP independiente)
packages/db/                esquema SQL, migrador, acceso por tenant, cifrado de tokens, seed, CLI
packages/provider-fixtures/ identidades del proveedor compartidas por mock y seed
scripts/init-env.sh         genera el .env local
scripts/deploy-db.sh        migraciones + roles + seed en la BD desplegada
infra/                      despliegue público (Railway, Vercel) y runbook
.github/workflows/ci.yml    pipeline: tests, imágenes, despliegue con aprobación y rollback
docker-compose.yml          stack local completo
```
