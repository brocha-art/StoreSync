-- 001 — Schema base (guía §4.2) CON los cambios de la Decisión 2 (secretos en Vault)
-- Tablas: artists, shops, products, variants, inventory_levels, product_images,
--         orders, order_items.
-- webhook_events / sync_events / audit_log van en la 002 (orden de ejecución, paso 3).
-- Idempotente: create table if not exists / create index if not exists.

-- ── Tenancy ───────────────────────────────────────────────────────────────────

create table if not exists artists (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now()
);

-- Decisión 2: NO existe access_token/webhook_secret en texto plano.
-- Los secretos viven en Vault; aquí solo las referencias (uuid de vault.secrets).
create table if not exists shops (
  id                     uuid primary key default gen_random_uuid(),
  artist_id              uuid not null references artists(id) on delete cascade,
  shop_domain            text unique not null,
  access_token_secret_id uuid not null,   -- referencia a vault.secrets (Decisión 2)
  webhook_secret_id      uuid not null,   -- el webhook secret también va al Vault
  location_id            text not null,   -- ubicación primaria de inventario (§2.2)
  inventory_tracked      boolean not null default false,
  -- Invariante §10: 401/403 jamás se reintenta → tienda marcada y jobs detenidos
  status                 text not null default 'active'
                         check (status in ('active', 'needs_reauth', 'paused')),
  created_at             timestamptz not null default now()
);

create index if not exists idx_shops_artist on shops(artist_id);

-- ── Catálogo ──────────────────────────────────────────────────────────────────

create table if not exists products (
  id                 uuid primary key default gen_random_uuid(),
  shop_id            uuid not null references shops(id) on delete cascade,
  shopify_product_id text not null,
  title              text,
  handle             text,
  description_html   text,
  status             text,
  -- products/delete = soft-delete local (guía §6.1, checklist §13 #3)
  deleted_at         timestamptz,
  updated_at         timestamptz default now(),
  unique (shop_id, shopify_product_id)
);

create table if not exists variants (
  id                 uuid primary key default gen_random_uuid(),
  product_id         uuid not null references products(id) on delete cascade,
  shopify_variant_id text not null,
  inventory_item_id  text not null,  -- imprescindible para escrituras outbound (§5/§8)
  sku                text,
  price              numeric(12,2),
  unique (product_id, shopify_variant_id)
);

-- inventory_levels/update llega con inventory_item_id: lookup directo
create index if not exists idx_variants_inventory_item on variants(inventory_item_id);

-- El objetivo del sync: cantidad vendible por variante por ubicación.
-- SOLO se escribe vía apply_inventory_change (migración 003) — nunca directo.
create table if not exists inventory_levels (
  id          uuid primary key default gen_random_uuid(),
  variant_id  uuid not null references variants(id) on delete cascade,
  location_id text not null,
  available   int not null default 0,
  updated_at  timestamptz not null default now(),
  unique (variant_id, location_id)
);

-- DDL no provisto por la guía (§4.1 solo describe propósito): URLs + metadata.
-- Hoy se guardan URLs del CDN de Shopify; copia a Storage queda como opción futura.
create table if not exists product_images (
  id               uuid primary key default gen_random_uuid(),
  product_id       uuid not null references products(id) on delete cascade,
  shopify_image_id text,
  url              text not null,
  alt_text         text,
  position         int not null default 0,
  updated_at       timestamptz not null default now(),
  unique (product_id, url)
);

-- ── Órdenes ───────────────────────────────────────────────────────────────────

-- DDL no provisto por la guía: header espejo de Shopify o creada por la plataforma.
create table if not exists orders (
  id                 uuid primary key default gen_random_uuid(),
  shop_id            uuid not null references shops(id) on delete cascade,
  shopify_order_id   text,              -- null si la orden nace en la plataforma
  source             text not null default 'shopify'
                     check (source in ('shopify', 'platform')),
  financial_status   text,
  fulfillment_status text,
  currency           text,
  total_amount       numeric(12,2),
  shopify_created_at timestamptz,
  cancelled_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (shop_id, shopify_order_id)
);

create table if not exists order_items (
  id                   uuid primary key default gen_random_uuid(),
  order_id             uuid not null references orders(id) on delete cascade,
  -- set null: borrar un producto no debe borrar el historial de ventas
  variant_id           uuid references variants(id) on delete set null,
  shopify_line_item_id text,
  sku                  text,
  title                text,
  quantity             int not null,
  price                numeric(12,2),
  created_at           timestamptz not null default now(),
  unique (order_id, shopify_line_item_id)
);

create index if not exists idx_order_items_variant on order_items(variant_id);

-- ── RLS: deny-all para clientes; solo service_role (server-side) ──────────────
-- Guía §11: RLS en toda tabla store-scoped; service_role jamás en cliente.
-- Sin policies para anon/authenticated (deny por defecto) + revoke explícito.
-- El consumidor externo llegará por el API gateway (Decisión 6), que autentica
-- por API key y aplica el scoping por tienda en código, siempre server-side.

alter table artists          enable row level security;
alter table shops            enable row level security;
alter table products         enable row level security;
alter table variants         enable row level security;
alter table inventory_levels enable row level security;
alter table product_images   enable row level security;
alter table orders           enable row level security;
alter table order_items      enable row level security;

revoke all on artists, shops, products, variants, inventory_levels,
              product_images, orders, order_items
  from anon, authenticated;
