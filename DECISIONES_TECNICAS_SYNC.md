# DECISIONES TÉCNICAS — Shopify ↔ Supabase Sync

> Complemento obligatorio de `Shopify_Supabase_Sync_Dev_Guide.docx`. Donde este documento
> contradiga a la guía, **gana este documento**. Resuelve los 6 puntos abiertos de la guía.
> Entregar ambos archivos a Claude Code como contexto inicial.

---

## DECISIÓN 1 — Versión de API: `2026-07`

La guía fija `2025-01`, que ya está fuera de soporte. Shopify responde a versiones muertas
con la versión estable más antigua disponible (float silencioso — exactamente lo que la guía
advierte evitar).

**Regla:** una sola constante, importada en TODO llamado a Shopify. Nunca hardcodear la
versión en una URL.

```ts
// src/config/shopify.ts
export const SHOPIFY_API_VERSION = "2026-07"; // Revisar trimestralmente (ene/abr/jul/oct)

export const shopifyGraphqlUrl = (shopDomain: string) =>
  `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
```

Agregar recordatorio en el README: cada release trimestral de Shopify, correr la suite de
tests (§13 de la guía) contra la versión nueva antes de subir la constante.

---

## DECISIÓN 2 — Tokens en Supabase Vault (NO en columna, NO en Edge secrets)

Resuelve la contradicción de la guía (§3.2 dice secrets, §4.2 dice columna cifrada).

**Por qué Vault:** los Edge Function secrets no escalan por tienda (redeploy por cada
artista nuevo). Una columna con ciphertext propio obliga a manejar llaves de cifrado a mano.
Vault cifra con llave gestionada por Supabase y expone descifrado solo server-side.

**Cambio al schema de la guía (§4.2):** reemplazar en `shops`:

```sql
-- ANTES (guía):  access_token text not null,
-- DESPUÉS:
access_token_secret_id uuid not null,   -- referencia a vault.secrets
webhook_secret_id      uuid not null    -- el webhook secret también va al Vault
```

**Guardar el token en onboarding:**

```sql
-- Se ejecuta desde la rutina de onboarding (service_role)
select vault.create_secret(
  'shpat_xxxxxxxxxxxx',                          -- el token
  'shop_token_' || :shop_domain,                 -- nombre único
  'Admin API token para ' || :shop_domain        -- descripción
);
-- devuelve el uuid → guardarlo en shops.access_token_secret_id
```

**Leer el token (solo dentro de Edge Functions / workers):**

```sql
-- Función RPC restringida: solo service_role puede ejecutarla
create or replace function get_shop_credentials(p_shop_id uuid)
returns table (shop_domain text, access_token text, webhook_secret text, location_id text)
language sql
security definer
set search_path = public, vault
as $$
  select s.shop_domain,
         t.decrypted_secret  as access_token,
         w.decrypted_secret  as webhook_secret,
         s.location_id
  from shops s
  join vault.decrypted_secrets t on t.id = s.access_token_secret_id
  join vault.decrypted_secrets w on w.id = s.webhook_secret_id
  where s.id = p_shop_id;
$$;

revoke all on function get_shop_credentials(uuid) from public, anon, authenticated;
grant execute on function get_shop_credentials(uuid) to service_role;
```

Regla de oro: el token descifrado vive solo en memoria del worker durante el request.
Jamás se loguea, jamás se devuelve en una respuesta HTTP.

---

## DECISIÓN 3 — Serialización por variante: `pg_advisory_xact_lock`

El mecanismo concreto del "un escritor por variante" que la guía enuncia sin diseñar.
Nativo de Postgres, cero infraestructura extra, se libera solo al terminar la transacción
(no hay locks huérfanos si el worker muere).

**TODA escritura de inventario (inbound Y outbound) pasa por esta función:**

```sql
create or replace function apply_inventory_change(
  p_variant_id  uuid,
  p_location_id text,
  p_new_available int,
  p_source text          -- 'shopify_webhook' | 'platform_sale' | 'reconciliation'
) returns int
language plpgsql
security definer
as $$
declare
  v_result int;
begin
  -- Un solo escritor por variante: quien llegue segundo espera, no interleave
  perform pg_advisory_xact_lock(hashtext(p_variant_id::text));

  insert into inventory_levels (variant_id, location_id, available, updated_at)
  values (p_variant_id, p_location_id, p_new_available, now())
  on conflict (variant_id, location_id)
  do update set available = excluded.available, updated_at = now()
  returning available into v_result;

  insert into audit_log (entity, entity_id, action, detail)
  values ('inventory', p_variant_id::text, 'set',
          jsonb_build_object('available', p_new_available, 'source', p_source));

  return v_result;
end;
$$;
```

**Flujo outbound completo (venta en plataforma):**

1. Worker toma el job de la cola.
2. Llama `apply_inventory_change(...)` → el advisory lock serializa contra cualquier
   webhook inbound de la misma variante.
3. Dentro de la MISMA lógica de worker: mutación `inventorySetQuantities` a Shopify con
   `compareQuantity` = valor que teníamos ANTES del cambio (concurrencia optimista, §8 guía).
4. Si Shopify rechaza por compare mismatch → NO reintentar ciego → encolar job de
   reconciliación para esa variante (ver Decisión 5).

---

## DECISIÓN 4 — Cola: **pgmq** (extensión nativa de Supabase)

Elegida sobre Trigger.dev para este proyecto: todo queda dentro de Postgres, el advisory
lock y la cola comparten la misma base, una pieza móvil menos, costo cero adicional.
(Trigger.dev queda como upgrade futuro si se necesita observabilidad avanzada.)

**Setup:**

```sql
create extension if not exists pgmq;
create extension if not exists pg_cron;

select pgmq.create('sync_jobs');        -- inbound: procesar webhooks
select pgmq.create('inventory_out');    -- outbound: escrituras a Shopify
select pgmq.create('reconcile');        -- reconciliación dirigida
```

**Encolar desde el receptor de webhooks (reemplaza el `enqueue()` fantasma de la guía §6.3):**

```ts
await supabase.rpc("pgmq_send", {
  queue_name: "sync_jobs",
  msg: { webhook_event_id: eventId, shop_id: shop.id, topic },
});
// o vía SQL directo: select pgmq.send('sync_jobs', '{"webhook_event_id": "..."}'::jsonb);
```

**Worker (Edge Function invocada por pg_cron cada minuto):**

```sql
-- Disparar el worker cada minuto
select cron.schedule('drain-sync-jobs', '* * * * *',
  $$ select net.http_post(
       url := 'https://<project>.supabase.co/functions/v1/worker-sync',
       headers := jsonb_build_object('Authorization', 'Bearer ' || <service_key_from_vault>)
     ) $$);
```

```ts
// worker-sync: leer con visibility timeout, procesar, archivar
const { data: msgs } = await supabase.rpc("pgmq_read", {
  queue_name: "sync_jobs", vt: 60, qty: 10,   // invisible 60s mientras se procesa
});
for (const m of msgs ?? []) {
  try {
    await processWebhookEvent(m.message);      // upsert normalizado + apply_inventory_change
    await supabase.rpc("pgmq_archive", { queue_name: "sync_jobs", msg_id: m.msg_id });
  } catch (e) {
    await logSyncEvent(m.message, "failed", e); // sync_events; pgmq lo re-entrega al vencer vt
    // tras N intentos (leer m.read_ct): mover a dead-letter y alertar (§10 guía)
  }
}
```

Backoff/reintentos: usar `read_ct` del mensaje. `read_ct > 5` → `pgmq.archive` +
fila en `sync_events` con status `dead_letter` + alerta.

---

## DECISIÓN 5 — Reconciliación en dos niveles (no barrido total cada 15 min)

El barrido completo cada 15-30 min de la guía (§9) drena el rate limit con varias tiendas.

**Nivel 1 — Incremental, cada 15 minutos, por tienda:**
Solo variantes "calientes": actividad o fallas recientes.

```sql
-- Candidatas a verificación dirigida
select distinct v.id as variant_id, v.inventory_item_id, s.id as shop_id
from variants v
join products p on p.id = v.product_id
join shops s on s.id = p.shop_id
where v.id in (
  -- escrituras fallidas o rechazadas por compareQuantity
  select (payload->>'variant_id')::uuid from sync_events
  where status in ('failed','retrying') and created_at > now() - interval '2 hours'
  union
  -- variantes con movimiento reciente
  select variant_id from inventory_levels
  where updated_at > now() - interval '30 minutes'
);
```

Para cada candidata: leer `available` actual en Shopify → comparar → si difiere aplicar
la regla de la guía: **tomar el número MENOR** y marcar para revisión humana si no se
puede explicar la diferencia. Reparar vía `apply_inventory_change(..., 'reconciliation')`.

**Nivel 2 — Barrido completo, 1 vez al día (3:00 AM), por tienda:**
Con **Bulk Operations** (no consume el rate limit normal). Query bulk de todas las
variantes con `inventoryQuantity`, comparar contra `inventory_levels`, generar el
discrepancy report de la guía (§9.2).

Todo rechazo por `compareQuantity` durante el día encola inmediatamente un job en la
cola `reconcile` para esa variante — no espera al ciclo de 15 min.

---

## DECISIÓN 6 — API Gateway para el consumidor externo (LeadGods u otros)

Alcance que la guía deja sin definir ("notify platform"). El consumidor NUNCA recibe
service_role ni connection string.

**Schema:**

```sql
create table api_consumers (
  id uuid primary key default gen_random_uuid(),
  name text not null,                      -- 'leadgods'
  key_hash text not null unique,           -- sha256 del API key, nunca el key plano
  allowed_shop_ids uuid[] not null,        -- scoping explícito por tienda
  rate_limit_per_min int not null default 120,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table api_request_log (
  id bigint generated always as identity primary key,
  consumer_id uuid references api_consumers(id),
  path text, shop_id uuid, status int,
  created_at timestamptz not null default now()
);
```

**Edge Function `api-gateway` (solo lectura):**

```ts
// 1. Autenticar: sha256(header 'x-api-key') vs api_consumers.key_hash, active = true
// 2. Autorizar: shop_id solicitado ∈ allowed_shop_ids, si no → 403
// 3. Rate limit: contar api_request_log del último minuto vs rate_limit_per_min → 429
// 4. Responder SOLO endpoints GET:
//    GET /shops/:shopId/products
//    GET /shops/:shopId/inventory
//    GET /shops/:shopId/orders?since=...
// 5. Registrar en api_request_log
```

Generación de keys: `crypto.randomBytes(32).toString('base64url')`, se muestra UNA vez,
se guarda solo el hash. Revocar = `active = false`.

**Futuro LeadGods (§14 guía):** además del gateway pull, emitir eventos de dominio
normalizados en tabla `domain_events` (outbox pattern) desde los mismos workers.
LeadGods podrá consumir por polling del gateway o suscripción Realtime a esa tabla.

---

## ⚠ VALIDACIÓN PENDIENTE (primera semana, tienda dev)

`inventorySetQuantities` con `name: "available"` vs estados `on_hand` / `committed`:
crear un pedido sin cumplir en la tienda de desarrollo y verificar que escribir
`available` se comporta como se espera con cantidades comprometidas. Es el escenario
exacto de sobreventa silenciosa. Documentar el resultado en `/docs`.

---

## ORDEN DE EJECUCIÓN ESTA NOCHE

1. `supabase init` + extensiones: `pgmq`, `pg_cron`, `pg_net` (Vault ya viene activo).
2. Migración 001: schema de la guía §4 CON los cambios de la Decisión 2 (secret_ids).
3. Migración 002: tablas de eventos (guía §4.3) + `api_consumers` + `api_request_log`.
4. Migración 003: `get_shop_credentials`, `apply_inventory_change`, colas pgmq.
5. Rutina de onboarding (guía §2.2): validar los 6 requisitos + guardar secrets en Vault
   + verificar location_id activo contra la API.
6. Receptor de webhooks (guía §6) usando `SHOPIFY_API_VERSION = 2026-07` y pgmq.
7. Worker inbound → luego import inicial (guía §5, capturando `inventory_item_id`).
8. Solo cuando una tienda esté verde: outbound (§7.2/§8) → reconciliación (Decisión 5)
   → gateway (Decisión 6). Respetar el BUILD ORDER de la guía.
