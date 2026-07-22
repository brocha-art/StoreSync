-- Smoke test de la fundación SQL (pasos 2–4 del orden de ejecución).
-- Corre TODO en una transacción y hace ROLLBACK: no deja datos.
--
-- Uso:
--   docker exec -i supabase_db_StoreSync psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < tests/smoke_fundacion.sql
--
-- Esperado:
--   token_ok = t, whsec_ok = t            (Vault → get_shop_credentials)
--   qty_1 = 7, qty_2 = 5                  (apply_inventory_change)
--   filas_inventario = 1, available = 5   (upsert, no duplica)
--   audit_rows = 2                        (una por escritura)
--   round-trip pgmq: read devuelve el mensaje, archive = t

begin;

-- 1) Vault + get_shop_credentials ida y vuelta
select vault.create_secret('shpat_smoke_token', 'smoke_token_test', 'smoke') as token_sid \gset
select vault.create_secret('whsec_smoke', 'smoke_whsec_test', 'smoke') as whsec_sid \gset

insert into artists (name) values ('Artista Smoke') returning id as artist_id \gset
insert into shops (artist_id, shop_domain, access_token_secret_id, webhook_secret_id, location_id, inventory_tracked)
values (:'artist_id', 'smoke.myshopify.com', :'token_sid', :'whsec_sid', 'gid://shopify/Location/1', true)
returning id as shop_id \gset

select (access_token = 'shpat_smoke_token') as token_ok,
       (webhook_secret = 'whsec_smoke')     as whsec_ok,
       shop_domain, location_id
from get_shop_credentials(:'shop_id');

-- 2) apply_inventory_change: advisory lock + upsert + audit
insert into products (shop_id, shopify_product_id, title)
values (:'shop_id', '111', 'Producto Smoke') returning id as product_id \gset
insert into variants (product_id, shopify_variant_id, inventory_item_id, sku)
values (:'product_id', '222', '333', 'SKU-SMOKE-1') returning id as variant_id \gset

select apply_inventory_change(:'variant_id', 'gid://shopify/Location/1', 7, 'shopify_webhook') as qty_1;
select apply_inventory_change(:'variant_id', 'gid://shopify/Location/1', 5, 'platform_sale')   as qty_2;

select count(*) as filas_inventario, min(available) as available
from inventory_levels where variant_id = :'variant_id';

select count(*) as audit_rows
from audit_log where entity = 'inventory' and entity_id = :'variant_id';

-- 3) Colas pgmq vía wrappers RPC
select pgmq_send('sync_jobs', '{"smoke": true}'::jsonb) as msg_id \gset
select msg_id, read_ct, message from pgmq_read('sync_jobs', 1, 10);
select pgmq_archive('sync_jobs', :'msg_id') as archived;

rollback;
