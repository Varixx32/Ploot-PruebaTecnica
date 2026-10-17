# Despliegue público

| Pieza | Plataforma | Región | Por qué |
|-------|-----------|--------|---------|
| App Next.js (API + UI) | Vercel | `fra1` (Frankfurt) | Serverless real: comprueba que la API convive con instancias efímeras gracias al pooler |
| Postgres 16 | Neon | `aws-eu-central-1` (Frankfurt) | Gestionado, gratis, con pooler PgBouncer en transaction mode y conexión directa |
| Worker ×2 | Railway | UE | Proceso de larga vida: espera `Retry-After`, mantiene leases y no tiene timeout de función |
| Mock del proveedor | Railway | UE | Servicio aparte; el worker lo llama por la red privada de Railway |

Todo en la UE (GDPR). Ningún secreto está en el repo: cada valor se configura en la plataforma.

## Conexiones a Postgres

| Quién | Rol | Endpoint de Neon | Motivo |
|-------|-----|------------------|--------|
| App (Vercel) | `ploot_app_login` (RLS) | **pooled** (`…-pooler…`) | N instancias serverless no agotan `max_connections`; RLS usa `SET LOCAL`, válido en transaction mode |
| Worker (Railway) | `ploot_worker_login` | directo | Pocas conexiones, larga vida |
| Migraciones (`scripts/deploy-db.sh`) | owner | directo | El advisory lock necesita una sesión |

## Pasos (una sola vez)

1. **Generar secretos** en local: `node scripts/deploy-env.mjs init` crea `.env.deploy` (gitignored) con
   todos los secretos aleatorios; solo falta pegar la URL de Neon en `DATABASE_URL`.
2. **Neon**: proyecto en `AWS Europe Central 1 (Frankfurt)`, Postgres 16. Copiar la *connection string*
   **directa** del owner.
3. **Base de datos**: `./scripts/deploy-db.sh` (usa siempre el host directo aunque se pegue el del pooler).
   Después, `node scripts/deploy-env.mjs render` escribe en `.deploy/` (gitignored) un fichero por plataforma
   con las variables ya montadas, listo para pegar en el *Raw Editor* de Railway y en Vercel.
   Aplica las migraciones, crea los usuarios `ploot_app_login` / `ploot_worker_login` y carga el seed de demo.
   Es idempotente.
4. **Railway**: proyecto en una región UE, conectado al repo (rama `assessment` mientras el PR no se mergee), con dos servicios.
   - `mock`: *Config file* `infra/railway/mock.json`. Variables: `MOCK_FIXTURE_SECRET`, `MOCK_ADMIN_KEY`,
     `MOCK_HOST=::` (la red privada de Railway usa IPv6) y `PORT=4000`.
   - `worker`: *Config file* `infra/railway/worker.json`. Variables:
     - `DATABASE_URL=postgres://ploot_worker_login:<WORKER_DB_PASSWORD>@<host directo>/<db>?sslmode=require`
     - `PROVIDER_BASE_URL=http://${{mock.RAILWAY_PRIVATE_DOMAIN}}:4000`
     - `TOKEN_ENC_KEYS`
5. **Vercel**: importar el repo con *Root Directory* `app` (usa `app/vercel.json`) y *Production Branch* `assessment`. Variables (Production):
   - `APP_DATABASE_URL=postgres://ploot_app_login:<APP_DB_PASSWORD>@<host -pooler>/<db>?sslmode=require`
   - `JWT_SECRET`, `APP_DB_POOL_MAX=1`, `DEMO_LOGIN_ENABLED=true`
6. **Comprobar**: `https://<app>.vercel.app/api/health`, después la UI con «Entrar como acme».
   Si algo va atrasado: `railway run --service worker npm run why -w @ploot/worker -- Bruno`
   (`railway run` ejecuta en local con las variables del servicio, que apuntan a Neon).

`TOKEN_ENC_KEYS` y `MOCK_FIXTURE_SECRET` deben coincidir entre `.env.deploy` y Railway: el seed cifra
y deriva los tokens con ellos.

## Pipeline

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml):

- **En cada PR**: typecheck, todos los tests contra un Postgres efímero y build de las 4 imágenes. Vercel publica un preview por PR.
- **Al hacer merge a `main`**: se publican las imágenes en GHCR y se despliega tras aprobación manual (environment `production`), en este orden:
  1. migraciones;
  2. worker y mock en Railway;
  3. app en Vercel;
  4. smoke test, con `vercel rollback` automático si falla.
- **Secretos del environment**: `NEON_DIRECT_URL`, `APP_DB_PASSWORD`, `WORKER_DB_PASSWORD`, `TOKEN_ENC_KEYS`,
  `MOCK_FIXTURE_SECRET`, `RAILWAY_TOKEN`, `VERCEL_TOKEN`, `VERCEL_ORG_ID` y `VERCEL_PROJECT_ID`, más la variable `PUBLIC_URL`.
