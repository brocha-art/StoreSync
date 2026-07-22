-- 005 — Ingesta atómica de webhooks (paso 6)
-- Materializa el enqueue() de la guía §6.3 con pgmq (Decisión 4), en UNA
-- transacción con el insert del payload crudo: o quedan fila + mensaje, o
-- nada. Si fueran dos pasos separados y el enqueue fallara tras el insert,
-- el retry de Shopify chocaría con el dedupe y el evento quedaría sin
-- encolar para siempre.
--
-- Invariante de idempotencia (literal): unique (shop_id, shopify_event_id),
-- insert-or-ignore; los duplicados se descartan ANTES de tocar datos.

create or replace function ingest_webhook_event(
  p_shop_id          uuid,
  p_topic            text,
  p_shopify_event_id text,
  p_payload          jsonb
) returns table (event_id uuid, was_new boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into webhook_events (shop_id, topic, shopify_event_id, payload)
  values (p_shop_id, p_topic, p_shopify_event_id, p_payload)
  on conflict (shop_id, shopify_event_id) do nothing
  returning id into v_id;

  if v_id is null then
    -- Redelivery (entrega at-least-once de Shopify): descartada aquí
    select we.id into v_id
    from webhook_events we
    where we.shop_id = p_shop_id and we.shopify_event_id = p_shopify_event_id;

    event_id := v_id;
    was_new  := false;
    return next;
    return;
  end if;

  perform pgmq.send('sync_jobs',
    jsonb_build_object(
      'webhook_event_id', v_id,
      'shop_id', p_shop_id,
      'topic', p_topic));

  event_id := v_id;
  was_new  := true;
  return next;
end;
$$;

revoke all on function ingest_webhook_event(uuid, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function ingest_webhook_event(uuid, text, text, jsonb)
  to service_role;
