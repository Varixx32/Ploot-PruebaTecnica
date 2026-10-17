# Worker

Proceso Node de larga vida (contenedor), fuera de cualquier función serverless. Las réplicas no
comparten memoria: se coordinan solo a través de Postgres.

## Ciclo

Cada tick (500 ms por defecto):

1. **Reaper**: recupera posts `publishing` con el lease vencido (worker muerto).
   - Sin intento abierto (la petición no salió) ⇒ vuelve a la cola.
   - Con intento abierto (pudo publicarse) ⇒ `failed / outcome_unknown`, **no se reintenta**:
     el proveedor no tiene idempotencia y un duplicado en la cuenta del Embajador es peor que un post perdido.
2. **Claim** en una transacción corta:
   - bloquea la fila del presupuesto compartido (`rate_buckets`), lo que hace exactos los caps globales;
   - elige solo la **cabeza de cola de cada Embajador**, en round-robin entre tenants y con tope de posts en vuelo por tenant;
   - `FOR UPDATE SKIP LOCKED` ⇒ `publishing` con lease.
3. **Publicación**: token (refresh si caduca, serializado por Embajador) → intento registrado → llamada al proveedor → resultado aplicado en una transacción, solo si se conserva el lease.

## Política por resultado

| Resultado | Qué pasa |
|-----------|----------|
| 200 | `published` + `external_id`; pacing del Embajador (`WORKER_AMBASSADOR_MIN_INTERVAL_SEC`) |
| 429 `scope=user` | Embajador en espera `Retry-After`; el post vuelve sin avanzar la cabeza de cola y sin gastar intento |
| 429 `scope=app` | Pausa global (todas las réplicas) durante `Retry-After` |
| 403 `account_restricted` | Embajador pausado `Retry-After`; el post espera |
| 401 expirado | Refresh y reintento en la misma posición |
| 401 revocado / refresh `invalid_grant` | `failed / token_revoked` sin reintentos; Embajador pausado hasta re-autenticar |
| 5xx / red sin enviar | Backoff exponencial con full jitter, máx. 5 intentos ⇒ `failed / provider_unavailable` |
| Timeout / conexión cortada | `failed / outcome_unknown` (pudo publicarse) |
| 422 | `failed / invalid_content` |

## Límites (variables de entorno)

| Variable | Defecto | |
|----------|---------|-|
| `WORKER_AMBASSADOR_MIN_INTERVAL_SEC` | 25 | Espaciado entre posts del mismo Embajador |
| `WORKER_APP_RATE_CAPACITY` / `_REFILL_PER_SEC` | 10 / 1.5 | Presupuesto compartido por todas las réplicas |
| `WORKER_GLOBAL_MAX_IN_FLIGHT` | 20 | Máximo de posts `publishing` en total |
| `WORKER_TENANT_MAX_IN_FLIGHT` | 5 | Máximo por tenant |
| `WORKER_LEASE_SEC` | 60 | Lease de un post en publicación |
| `WORKER_MAX_ATTEMPTS` | 5 | Intentos ante errores transitorios |

Además: 1 post en vuelo por Embajador, garantizado por un índice único parcial en Postgres.

## Observabilidad

- `node dist/why.js <embajador>`: estado de su cola, motivo de la espera y últimos intentos.
- `GET :9464/metrics`: outcomes por tipo, backlog vencido, lag del post más antiguo, pausa de app.
- `GET :9464/healthz`.
- Logs JSON por intento: `post_id`, `ambassador_id`, `outcome`, `http_status`, `retry_after_sec`, `lag_ms`.
