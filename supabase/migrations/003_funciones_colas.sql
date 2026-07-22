-- 003 — Funciones núcleo + colas pgmq (Decisiones 2, 3 y 4)
-- Idempotente: create or replace / guards sobre pgmq.list_queues().

-- ── get_shop_credentials (Decisión 2) ─────────────────────────────────────────
-- ÚNICO punto de descifrado de secretos. El token descifrado vive solo en
-- memoria del worker durante el request: jamás en logs, jamás en respuestas HTTP.

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

-- ── apply_inventory_change (Decisión 3) ───────────────────────────────────────
-- TODA escritura de inventario (inbound, outbound y reconciliación) pasa por
-- aquí. pg_advisory_xact_lock = un solo escritor por variante; se libera solo
-- al terminar la transacción (no quedan locks huérfanos si el worker muere).

create or replace function apply_inventory_change(
  p_variant_id  uuid,
  p_location_id text,
  p_new_available int,
  p_source text  -- 'shopify_webhook' | 'platform_sale' | 'reconciliation' | 'initial_import'
) returns int
language plpgsql
security definer
set search_path = public
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

-- Sin esto, cualquier cliente anon podría fijar inventario vía PostgREST
-- (security definer en public es ejecutable por PUBLIC por defecto).
revoke all on function apply_inventory_change(uuid, text, int, text) from public, anon, authenticated;
grant execute on function apply_inventory_change(uuid, text, int, text) to service_role;

-- ── Colas pgmq (Decisión 4) ───────────────────────────────────────────────────

do $$
begin
  if not exists (select 1 from pgmq.list_queues() where queue_name = 'sync_jobs') then
    perform pgmq.create('sync_jobs');      -- inbound: procesar webhooks
  end if;
  if not exists (select 1 from pgmq.list_queues() where queue_name = 'inventory_out') then
    perform pgmq.create('inventory_out');  -- outbound: escrituras a Shopify
  end if;
  if not exists (select 1 from pgmq.list_queues() where queue_name = 'reconcile') then
    perform pgmq.create('reconcile');      -- reconciliación dirigida
  end if;
end $$;

-- ── Wrappers RPC para pgmq ────────────────────────────────────────────────────
-- El schema pgmq no está expuesto por PostgREST. La Decisión 4 llama
-- rpc('pgmq_send' | 'pgmq_read' | 'pgmq_archive'), así que se exponen wrappers
-- en public restringidos a service_role, con los MISMOS nombres de argumento
-- que usan los llamados del worker/receptor.

create or replace function pgmq_send(queue_name text, msg jsonb)
returns setof bigint
language sql
security definer
set search_path = ''
as $$
  select pgmq.send(queue_name, msg);
$$;

create or replace function pgmq_read(queue_name text, vt integer, qty integer)
returns setof pgmq.message_record
language sql
security definer
set search_path = ''
as $$
  select * from pgmq.read(queue_name, vt, qty);
$$;

create or replace function pgmq_archive(queue_name text, msg_id bigint)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select pgmq.archive(queue_name, msg_id);
$$;

revoke all on function pgmq_send(text, jsonb) from public, anon, authenticated;
revoke all on function pgmq_read(text, integer, integer) from public, anon, authenticated;
revoke all on function pgmq_archive(text, bigint) from public, anon, authenticated;
grant execute on function pgmq_send(text, jsonb) to service_role;
grant execute on function pgmq_read(text, integer, integer) to service_role;
grant execute on function pgmq_archive(text, bigint) to service_role;
