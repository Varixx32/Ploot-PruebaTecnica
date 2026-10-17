# Mock del proveedor

Servicio HTTP independiente (Fastify + TypeScript) que simula la red social. El worker lo
consume solo por HTTP. Estado en memoria: reiniciarlo lo devuelve a las fixtures.

## Contrato

### `POST /provider/publish`
Headers: `Authorization: Bearer <access_token>`, opcional `X-Client-Ref: <post_id>`.
Body: `{ "text": "..." }` (1–3000 caracteres).

| Status | Body | Significado para el cliente |
|--------|------|-----------------------------|
| 200 | `{ id, published_at }` | Publicado. `id` es el `external_id`. |
| 401 | `{ error: "token_expired" }` | Recuperable: refrescar y reintentar. |
| 401 | `{ error: "token_revoked" }` | Irrecuperable: no reintentar. |
| 401 | `{ error: "invalid_token" }` | Token desconocido / rotado. |
| 403 | `{ error: "account_restricted", retry_after }` | Soft-ban por ignorar `Retry-After`. |
| 422 | `{ error: "invalid_content" }` | Contenido inválido: no reintentar. |
| 429 | `{ error: "rate_limited", scope, retry_after }` + headers `Retry-After`, `X-RateLimit-Scope: user\|app` | Esperar. `scope` dice si frenar al Embajador o a toda la app. |
| 500/502/503 | `{ error: "provider_unavailable" }` | Transitorio: backoff. |

Orden de evaluación: latencia → auth → rate limit → fallo transitorio → validación → publicación.

### `POST /provider/oauth/refresh`
Body: `{ "refresh_token": "..." }`.

| Status | Body |
|--------|------|
| 200 | `{ access_token, refresh_token, token_type, expires_in }` (rota el par) |
| 400 | `{ error: "invalid_grant", error_description: "grant_revoked" \| "refresh_token_reused" \| "unknown_refresh_token" }` |
| 400 | `{ error: "invalid_request" }` |
| 5xx | Transitorio. **No** consume el refresh token. |

## Configuración

| Variable | Defecto | Efecto |
|----------|---------|--------|
| `MOCK_FIXTURE_SECRET` | — (obligatoria) | Secreto del que se derivan los tokens iniciales |
| `MOCK_LATENCY_MAX_MS` | 3000 | Latencia aleatoria 0–N ms en ambos endpoints |
| `MOCK_5XX_RATE` | 0.1 | Probabilidad de 5xx en publish y refresh |
| `MOCK_SEED` | aleatoria | Fija la secuencia de latencias y fallos |
| `MOCK_ACCESS_TOKEN_TTL_SEC` | 600 | Vida de los access tokens emitidos por refresh |
| `MOCK_USER_RL_CAPACITY` / `_REFILL_PER_SEC` | 3 / 0.05 | Token bucket por Embajador |
| `MOCK_APP_RL_CAPACITY` / `_REFILL_PER_SEC` | 20 / 2 | Token bucket por app (compartido por todos los tenants) |
| `MOCK_ABUSE_STRIKES` / `_WINDOW_SEC` / `_RESTRICTION_SEC` | 5 / 60 / 300 | Peticiones con el cupo agotado antes del soft-ban (`403 account_restricted`) y su duración |
| `MOCK_ADMIN_ENABLED` / `MOCK_ADMIN_KEY` | true / — | Endpoints `/__admin/*` y la clave que exigen (obligatoria en compose) |

Header `X-Mock-Force: 429|500|502|503` fuerza una respuesta concreta (tests y demo).

## Tokens de prueba

Las identidades y su estado inicial (`valid`, `expired` resoluble con refresh, `revoked`
irrecuperable) están en [`packages/provider-fixtures`](../packages/provider-fixtures/accounts.json).
Los tokens no se guardan en ningún sitio: el mock y el seed los derivan con HMAC-SHA256 de
`MOCK_FIXTURE_SECRET`. La caducidad es relativa al arranque del mock.

## Admin (`/__admin/*`, solo test/demo)

Activo si `MOCK_ADMIN_ENABLED=true`. Exige el header `X-Admin-Key: $MOCK_ADMIN_KEY`.

| Endpoint | Uso |
|----------|-----|
| `GET /__admin/publishes` | Ledger de todo lo publicado + `duplicates` por `client_ref` (prueba de no-doble-publicación) |
| `GET /__admin/tokens` | Estado de cada identidad |
| `GET /__admin/restrictions` | Cuentas en soft-ban |
| `POST /__admin/tokens/:providerUserId/revoke` | Revocar en caliente (demo de revocación a mitad de lote) |
| `POST /__admin/reset` | Volver al estado inicial |

## Desarrollo

```bash
npm run dev -w @ploot/mock     # tsx watch
npm test -w @ploot/mock        # vitest, reloj falso, sin red
```
