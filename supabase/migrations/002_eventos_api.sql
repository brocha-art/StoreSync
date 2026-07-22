-- 002 — Observabilidad e idempotencia (guía §4.3) + consumidores API (Decisión 6)
-- Idempotente: create table if not exists / create index if not exists.

-- Payloads crudos de webhooks. La idempotencia ES el unique:
-- insert-or-ignore sobre (shop_id, shopify_event_id) descarta redeliveries
-- ANTES de tocar datos (Shopify entrega at-least-once).
create table if not exists webhook_events (
  id               uuid primary key default gen_random_uuid(),
  shop_id          uuid references shops(id) on delete cascade,
  topic            text not null,            -- ej. products/update
  shopify_event_id text,                     -- header X-Shopify-Webhook-Id
  payload          jsonb not null,
  received_at      timestamptz not null default now(),
  processed_at     timestamptz,
  unique (shop_id, shopify_event_id)
);

-- Ops: eventos aún no procesados (el worker consume de pgmq, no barre esta tabla)
create index if not exists idx_webhook_events_pendientes
  on webhook_events(received_at) where processed_at is null;

-- Todo intento de sync + resultado.
create table if not exists sync_events (
  id         uuid primary key default gen_random_uuid(),
  shop_id    uuid references shops(id) on delete cascade,
  direction  text not null,   -- inbound | outbound
  entity     text not null,   -- product | variant | inventory | order
  status     text not null,   -- success | failed | retrying | dead_letter (Decisión 4)
  error      text,
  attempts   int default 0,
  -- Delta resuelto por precedencia: la reconciliación dirigida (Decisión 5)
  -- selecciona candidatas leyendo payload->>'variant_id'; la DDL de la guía
  -- no traía esta columna.
  payload    jsonb,
  created_at timestamptz not null default now()
);

-- Para la query de candidatas de la Decisión 5 (status + ventana temporal)
create index if not exists idx_sync_events_status_created on sync_events(status, created_at);
create index if not exists idx_sync_events_shop_created   on sync_events(shop_id, created_at);

-- Trail humano de cambios de estado. Shape dictado por el insert de
-- apply_inventory_change (Decisión 3): entity, entity_id, action, detail.
create table if not exists audit_log (
  id         bigint generated always as identity primary key,
  shop_id    uuid references shops(id) on delete set null,  -- el trail sobrevive a la tienda
  entity     text not null,
  entity_id  text not null,
  action     text not null,
  detail     jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_audit_log_entity on audit_log(entity, entity_id);

-- ── Consumidores del API gateway (Decisión 6) ─────────────────────────────────
-- Solo el schema hoy; la Edge Function api-gateway viene DESPUÉS de que una
-- tienda esté verde en inbound (BUILD ORDER). El consumidor jamás recibe
-- service_role ni connection string.

create table if not exists api_consumers (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,             -- 'leadgods'
  key_hash           text not null unique,      -- sha256 del API key, nunca el key plano
  allowed_shop_ids   uuid[] not null,           -- scoping explícito por tienda
  rate_limit_per_min int not null default 120,
  active             boolean not null default true,
  created_at         timestamptz not null default now()
);

create table if not exists api_request_log (
  id          bigint generated always as identity primary key,
  consumer_id uuid references api_consumers(id),
  path        text,
  shop_id     uuid,
  status      int,
  created_at  timestamptz not null default now()
);

-- Conteo del rate limit: requests del consumidor en el último minuto
create index if not exists idx_api_request_log_consumer_created
  on api_request_log(consumer_id, created_at);

-- ── RLS deny-all (igual que 001): solo service_role server-side ───────────────

alter table webhook_events  enable row level security;
alter table sync_events     enable row level security;
alter table audit_log       enable row level security;
alter table api_consumers   enable row level security;
alter table api_request_log enable row level security;

revoke all on webhook_events, sync_events, audit_log, api_consumers, api_request_log
  from anon, authenticated;
