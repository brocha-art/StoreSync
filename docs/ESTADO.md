# ESTADO — sesión 2026-07-21/22 (pasos 1–7 del orden de ejecución)

> Para retomar sin perder contexto. Documentos rectores en la raíz:
> `Shopify_Supabase_Sync_Dev_Guide.docx` + `DECISIONES_TECNICAS_SYNC.md`
> (las decisiones SIEMPRE ganan ante contradicción).

## Qué se construyó (todo verificado en local)

| Paso | Entregable | Verificación |
|---|---|---|
| 1 | Init + extensiones (`000`), estructura §12.1, `SHOPIFY_API_VERSION=2026-07` en constante única | extensiones instaladas tras `db reset` |
| 2 | `001_schema_base.sql`: 8 tablas con Decisión 2 (Vault `secret_id`s, sin token plano), `shops.status`, soft-delete, RLS deny-all | 13 tablas totales, `relrowsecurity=t`, anon 42501 |
| 3 | `002_eventos_api.sql`: `webhook_events` (unique idempotencia), `sync_events` (+`payload` que exige Decisión 5), `audit_log`, `api_consumers`, `api_request_log` | `db reset` limpio |
| 4 | `003_funciones_colas.sql`: `get_shop_credentials`, `apply_inventory_change` (advisory lock), colas pgmq + wrappers RPC service_role-only | `tests/smoke_fundacion.sql` verde; anon denegado vía PostgREST; re-apply idempotente |
| 5 | `004_onboarding.sql` + `src/services/onboarding.ts`: 6 requisitos §2.2 bloqueantes (location activa contra API), rotación = recuperación de `needs_reauth` | `tests/smoke_onboarding.sql` verde; typecheck OK |
| 6 | `005_ingesta_webhooks.sql` (persist+enqueue atómico) + Edge Function `webhook` (HMAC raw + `timingSafeEqual`) + registro §6.1 idempotente | `tests/test_receptor_webhooks.sh`: 4/4 verde |
| 7 | Edge Function `worker-sync` (pgmq vt=60, dead-letter read_ct>5) + handlers §7.1 + import §5 (`CatalogSource`, fase 2 por location, Bulk stub) + `006_cron_worker.sql` | `tests/test_worker_inbound.sh`: 100% verde |

**Checklist §13 marcado en local:** #8 (duplicado aplicado una vez) y #9 (HMAC malo
rechazado sin escribir). El resto exige tienda Shopify real conectada.

**Invariantes en pie:** inventario SOLO vía `apply_inventory_change`; secretos SOLO
en Vault (descifrado único: `get_shop_credentials`); 401/403 → `needs_reauth` sin
retry (`markShopNeedsReauth`); idempotencia por `unique(shop_id, shopify_event_id)`;
service_role solo server-side (deny-all verificado); HMAC constante sobre body crudo.

## Decisiones de implementación de esta sesión (dentro de la latitud de los docs)

1. IDs de Shopify: **numérico como texto en DB**; GID solo en frontera GraphQL (`src/services/gid.ts`).
2. Ingesta de webhooks **atómica** (fila + mensaje en una transacción, migración 005).
3. RLS **deny-all** (sin policies anon/authenticated + revoke): el acceso externo será el gateway (Decisión 6).
4. Re-onboarding = **rotación** (`vault.update_secret`, mismos secret_ids) + `status='active'`.
5. Órdenes espejo **sin tocar inventario** (Shopify emite su propio `inventory_levels/update`; evita doble descuento).
6. Worker: `processed_at` evita re-aplicar en redeliveries; handlers upsert + set absoluto ⇒ reproceso inocuo.
7. Handlers del worker viven junto a la Edge Function (bundling); mappers Node en `src/` (shapes distintos: REST vs GraphQL).
8. Puertos locales 55321+ (54xxx ocupados por otro proyecto local).
9. **Auth del worker por token dedicado** (`WORKER_SYNC_TOKEN`), no la service key:
   en el despliegue real, la `service_role` legacy que devuelve la API ≠ la
   `SUPABASE_SERVICE_ROLE_KEY` que el runtime inyecta (proyectos con keys
   nuevas `sb_secret_…`) y el cron recibía 401 silencioso del worker. El token
   propio vive en `supabase secrets set` + Vault (`worker_sync_token`) y
   desacopla la invocación interna del formato de keys de Supabase.

## NO construido aún (por diseño — BUILD ORDER)

- Outbound §7.2/§8 (`inventorySetQuantities` + `compareQuantity`, cola `inventory_out`).
- Reconciliación (Decisión 5, dos niveles) y cola `reconcile` (ya existe la cola).
- API gateway (Decisión 6; las tablas ya existen).
- `BulkCatalogSource` (§5.3) — interfaz lista, stub documentado.
- Canal real de alertas (hoy: `sync_events` + stderr) — PENDIENTES #5.
- Validación `available` vs `on_hand/committed` — PENDIENTES #1 (semana 1 con tienda dev).

## Despliegue cloud — EJECUTADO Y VALIDADO (2026-07-22)

Proyecto `fgrpclxpjciosvjzbefo` (org `ybjvneingmxwkrbvomqo`), CLI enlazada.

- Migraciones 000–006 aplicadas vía `db push` sobre base **verificada vacía**.
- Batería SQL remota: 4 extensiones, 13 tablas (13 con RLS), 3 colas, 8 funciones, cron activo.
- Edge Functions `webhook` y `worker-sync` desplegadas: GET→405, POST sin firma→401, worker sin token→401.
- Cron `drain-sync-jobs` (job 1, cada minuto) con `WORKER_SYNC_TOKEN` leído del Vault.
- **E2E real validado**: webhook firmado → 200, replay → dedupe, tick del cron →
  worker drenó → producto+variante creados, `processed_at` marcado, `sync_events`
  success, cola en 0. Datos de prueba limpiados después.
- Incidente encontrado y resuelto: 401 cron→worker por mismatch de formato de
  keys (decisión de implementación #9). El secreto Vault con la service key
  legacy fue eliminado; solo queda `worker_sync_token`.
- `.env.cloud` local (gitignored) con la URL + secret key del proyecto para
  correr los scripts contra el cloud: `cp .env.cloud .env` (volver a local:
  regenerar desde `supabase status -o env`).

## SIGUIENTE PASO EXACTO (próxima sesión)

1. **Alta de la tienda dev real** (valida los 6 requisitos §2.2 y bloquea si algo falla):
   ```bash
   cp .env.cloud .env
   SHOPIFY_ADMIN_TOKEN=shpat_... SHOPIFY_WEBHOOK_SECRET=... npm run onboard -- \
     --shop-domain <tienda>.myshopify.com --location-id <id> --artist-name "<Artista>"
   ```
2. **Import inicial**: `npm run import-catalog -- --shop-id <uuid>` (verifica completitud).
3. **Webhooks en vivo** (solo tras import — BUILD ORDER):
   `npm run register-webhooks -- --shop-id <uuid> --callback-url https://fgrpclxpjciosvjzbefo.supabase.co/functions/v1/webhook`
4. **Checklist §13** con la tienda real: #1–#4 y #7 (inbound); documentar PENDIENTES #1 y #3.
5. Con la tienda verde en inbound → **outbound §7.2/§8** (siguiente bloque del BUILD ORDER).

## Cómo correr todo en local

```bash
supabase start                      # stack (puertos 55321+)
supabase db reset                   # aplica 000-006
docker exec -i supabase_db_StoreSync psql -U postgres -d postgres -v ON_ERROR_STOP=1 < tests/smoke_fundacion.sql
docker exec -i supabase_db_StoreSync psql -U postgres -d postgres -v ON_ERROR_STOP=1 < tests/smoke_onboarding.sql
docker exec -i supabase_db_StoreSync psql -U postgres -d postgres -v ON_ERROR_STOP=1 < tests/seed_tienda_prueba.sql
supabase functions serve            # en otra terminal
bash tests/test_receptor_webhooks.sh
bash tests/test_worker_inbound.sh
npm run typecheck
```

Repo: https://github.com/brocha-art/StoreSync (main al día con los 7 pasos).
