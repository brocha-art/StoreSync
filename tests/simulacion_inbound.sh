#!/usr/bin/env bash
# Simulación de vida real del flujo INBOUND — SIN token de Shopify.
# Dispara la secuencia completa de webhooks sintéticos firmados que Shopify
# mandaría, y verifica el estado final en la base:
#
#   1. products/create   (producto con 2 variantes + imagen)
#   2. inventory_levels/update -> available=25
#   3. inventory_levels/update -> available=24   (venta en Shopify)
#   4. orders/create     (orden pagada con line item)
#   5. orders/cancelled  (cancelación)
#   6. products/delete   (soft-delete local)
#   7. replay del evento 2 (dedupe: no debe re-aplicar nada)
#
# Lo ÚNICO que no ejercita esto es hablarle a Shopify (onboarding/import/
# registro de webhooks y el futuro outbound): eso sí requiere tienda + token.
#
# Uso:
#   bash tests/simulacion_inbound.sh            # local (worker invocado directo)
#   MODE=cloud bash tests/simulacion_inbound.sh # cloud (espera al cron real, ~1-2 min)
#   KEEP=1 ...                                  # no limpiar datos al final
set -euo pipefail

MODE="${MODE:-local}"
SECRET='whsec_prueba_1234567890'
DOMAIN='prueba-local.myshopify.com'
PREFIX="sim-$RANDOM$RANDOM"

if [ "$MODE" = "cloud" ]; then
  BASE='https://fgrpclxpjciosvjzbefo.supabase.co/functions/v1'
  pq() { supabase db query --linked "select ($1) as valor;" 2>/dev/null | grep '"valor"' | sed -E 's/.*"valor": ?"?([^",]*)"?,?/\1/'; }
  runsql() { supabase db query --linked "$1" >/dev/null 2>&1; }
else
  BASE='http://127.0.0.1:55321/functions/v1'
  pq() { docker exec supabase_db_StoreSync psql -U postgres -d postgres -tA -c "select ($1);"; }
  runsql() { docker exec supabase_db_StoreSync psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 -c "$1"; }
fi

fail() { echo "✖ $1"; exit 1; }
ok()   { echo "✔ $1"; }

# ── Seed idempotente de la tienda de prueba ──────────────────────────────────
runsql "do \$\$ declare v_artist uuid; begin
  select id into v_artist from artists where name = 'Artista Prueba Local';
  if v_artist is null then
    insert into artists (name) values ('Artista Prueba Local') returning id into v_artist;
  end if;
  perform create_shop_with_secrets(v_artist, '$DOMAIN', 'shpat_token_prueba_local',
                                   '$SECRET', '77777777777', true);
end \$\$;"
ok "tienda de prueba lista ($MODE)"

post() { # $1=topic $2=event_id $3=body
  local hmac code
  hmac=$(printf '%s' "$3" | openssl dgst -sha256 -hmac "$SECRET" -binary | base64)
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/webhook" \
    -H "Content-Type: application/json" \
    -H "X-Shopify-Shop-Domain: $DOMAIN" \
    -H "X-Shopify-Topic: $1" \
    -H "X-Shopify-Webhook-Id: $2" \
    -H "X-Shopify-Hmac-Sha256: $hmac" \
    -d "$3")
  [ "$code" = "200" ] || fail "$1 ($2): esperaba 200, llegó $code"
}

# ── Secuencia de vida real ───────────────────────────────────────────────────
P_CREATE='{"id":700100200,"title":"Vinilo Edición Limitada","handle":"vinilo-ed-limitada","status":"active","variants":[{"id":700100201,"sku":"VIN-001","price":"35.00","inventory_item_id":700100301},{"id":700100202,"sku":"VIN-002","price":"40.00","inventory_item_id":700100302}],"images":[{"id":9001,"src":"https://cdn.shopify.com/vinilo-sim.jpg","alt":"Vinilo","position":1}]}'
P_INV25='{"inventory_item_id":700100301,"location_id":77777777777,"available":25}'
P_INV24='{"inventory_item_id":700100301,"location_id":77777777777,"available":24}'
P_ORDER='{"id":700200100,"financial_status":"paid","currency":"USD","total_price":"35.00","created_at":"2026-07-22T12:00:00Z","line_items":[{"id":700200101,"variant_id":700100201,"sku":"VIN-001","title":"Vinilo Edición Limitada","quantity":1,"price":"35.00"}]}'
P_CANCEL='{"id":700200100,"financial_status":"refunded","currency":"USD","total_price":"35.00","created_at":"2026-07-22T12:00:00Z","cancelled_at":"2026-07-22T13:00:00Z","line_items":[{"id":700200101,"variant_id":700100201,"sku":"VIN-001","title":"Vinilo Edición Limitada","quantity":1,"price":"35.00"}]}'
P_DELETE='{"id":700100200}'

post "products/create"         "$PREFIX-1" "$P_CREATE"
post "inventory_levels/update" "$PREFIX-2" "$P_INV25"
post "inventory_levels/update" "$PREFIX-3" "$P_INV24"
post "orders/create"           "$PREFIX-4" "$P_ORDER"
post "orders/cancelled"        "$PREFIX-5" "$P_CANCEL"
post "products/delete"         "$PREFIX-6" "$P_DELETE"
post "inventory_levels/update" "$PREFIX-2" "$P_INV25"   # replay exacto del evento 2
ok "7 webhooks firmados aceptados (6 eventos + 1 replay deduplicado)"

# ── Drenar ───────────────────────────────────────────────────────────────────
if [ "$MODE" = "cloud" ]; then
  echo "… esperando al cron de producción (corre cada minuto)"
  for i in $(seq 1 12); do
    EN_COLA=$(pq "select count(*) from pgmq.q_sync_jobs")
    [ "$EN_COLA" = "0" ] && break
    sleep 12
  done
  [ "${EN_COLA:-1}" = "0" ] || fail "el cron no drenó la cola en ~2.5 min (quedan $EN_COLA)"
  ok "el cron de producción drenó la cola solo"
else
  WORKER_SYNC_TOKEN=$(grep '^WORKER_SYNC_TOKEN=' supabase/functions/.env | cut -d= -f2-)
  [ -n "$WORKER_SYNC_TOKEN" ] || fail "sin WORKER_SYNC_TOKEN en supabase/functions/.env"
  resp=$(curl -s -X POST "$BASE/worker-sync" -H "Authorization: Bearer $WORKER_SYNC_TOKEN")
  echo "  worker: $resp"
fi

# ── Verificaciones de estado final ───────────────────────────────────────────
[ "$(pq "select count(*) from products where shopify_product_id='700100200' and title='Vinilo Edición Limitada'")" = "1" ] || fail "producto no creado"
ok "producto creado con título correcto"

[ "$(pq "select count(*) from variants v join products p on p.id=v.product_id where p.shopify_product_id='700100200'")" = "2" ] || fail "variantes != 2"
[ "$(pq "select count(*) from product_images pi join products p on p.id=pi.product_id where p.shopify_product_id='700100200'")" = "1" ] || fail "imagen no guardada"
ok "2 variantes + 1 imagen"

INV=$(pq "select il.available from inventory_levels il join variants v on v.id=il.variant_id where v.inventory_item_id='700100301' and il.location_id='77777777777'")
[ "$INV" = "24" ] || fail "inventario final esperado 24 (25→24, replay del 25 deduplicado); hay '$INV'"
ok "inventario final = 24: la venta aplicó y el replay NO revirtió (checklist #2/#8)"

[ "$(pq "select count(*) from orders where shopify_order_id='700200100' and cancelled_at is not null")" = "1" ] || fail "orden sin cancelled_at"
[ "$(pq "select count(*) from order_items oi join orders o on o.id=oi.order_id where o.shopify_order_id='700200100' and oi.variant_id is not null")" = "1" ] || fail "line item sin variante enlazada"
ok "orden espejada, line item enlazado a la variante, cancelación registrada"

[ "$(pq "select count(*) from products where shopify_product_id='700100200' and deleted_at is not null")" = "1" ] || fail "sin soft-delete"
ok "products/delete = soft-delete, no huérfano (checklist #3 en local)"

[ "$(pq "select count(*) from webhook_events where shopify_event_id='$PREFIX-2'")" = "1" ] || fail "el replay duplicó el evento"
[ "$(pq "select count(*) from audit_log al join variants v on v.id::text=al.entity_id where v.inventory_item_id='700100301' and al.entity='inventory'")" = "2" ] || fail "audit esperaba exactamente 2 escrituras de inventario"
ok "dedupe exacto: 1 fila por evento, 2 escrituras de inventario en audit (no 3)"

SYNC_OK=$(pq "select count(*) from sync_events where status='success' and created_at > now() - interval '10 minutes'")
[ "$SYNC_OK" -ge 6 ] || fail "sync_events success insuficientes ($SYNC_OK)"
ok "rastro completo en sync_events ($SYNC_OK success recientes)"

# ── Limpieza (KEEP=1 para conservar y explorar en Studio) ────────────────────
if [ "${KEEP:-0}" = "1" ]; then
  echo "· datos conservados (KEEP=1) — tienda '$DOMAIN'"
else
  runsql "delete from artists where name = 'Artista Prueba Local';"
  runsql "delete from vault.secrets where name like '%$DOMAIN';"
  runsql "select pgmq.purge_queue('sync_jobs');"
  ok "datos de simulación limpiados"
fi

echo
echo "SIMULACIÓN INBOUND ($MODE): TODO VERDE"
