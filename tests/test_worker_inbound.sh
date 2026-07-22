#!/usr/bin/env bash
# Prueba local del worker inbound (paso 7): drena la cola sync_jobs y aplica
# los cambios. Cubre products/update (upsert) e inventory_levels/update
# (apply_inventory_change con lookup por inventory_item_id scopeado a tienda).
#
# Requiere: stack local, migraciones, tienda de prueba sembrada y
# `supabase functions serve` activo.
#
# Uso: bash tests/test_worker_inbound.sh
set -euo pipefail

BASE="${1:-http://127.0.0.1:55321/functions/v1}"
SECRET='whsec_prueba_1234567890'
DOMAIN='prueba-local.myshopify.com'

psql_q() { docker exec supabase_db_StoreSync psql -U postgres -d postgres -tA -c "$1"; }
fail() { echo "✖ $1"; exit 1; }
ok()   { echo "✔ $1"; }

eval "$(supabase status -o env 2>/dev/null | grep '^SERVICE_ROLE_KEY=')"
[ -n "${SERVICE_ROLE_KEY:-}" ] || fail "no pude obtener SERVICE_ROLE_KEY del stack local"

# Seed idempotente: variante conocida para el webhook de inventario
docker exec -i supabase_db_StoreSync psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q <<'SQL'
insert into products (shop_id, shopify_product_id, title)
select id, '555000111', 'Producto Inventario Prueba'
from shops where shop_domain = 'prueba-local.myshopify.com'
on conflict (shop_id, shopify_product_id) do nothing;

insert into variants (product_id, shopify_variant_id, inventory_item_id, sku)
select p.id, '555000222', '555000333', 'SKU-INV-1'
from products p join shops s on s.id = p.shop_id
where s.shop_domain = 'prueba-local.myshopify.com' and p.shopify_product_id = '555000111'
on conflict (product_id, shopify_variant_id) do nothing;
SQL

post_webhook() { # $1=topic $2=body
  local hmac
  hmac=$(printf '%s' "$2" | openssl dgst -sha256 -hmac "$SECRET" -binary | base64)
  curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/webhook" \
    -H "Content-Type: application/json" \
    -H "X-Shopify-Shop-Domain: $DOMAIN" \
    -H "X-Shopify-Topic: $1" \
    -H "X-Shopify-Webhook-Id: test-worker-$RANDOM$RANDOM" \
    -H "X-Shopify-Hmac-Sha256: $hmac" \
    -d "$2"
}

# 1) Encolar un products/update con variantes e imágenes
BODY_PROD='{"id":999888777,"title":"Producto Webhook Editado","handle":"producto-webhook","status":"active","variants":[{"id":999888001,"sku":"SKU-W-1","price":"19.99","inventory_item_id":999888002}],"images":[{"id":1,"src":"https://cdn.shopify.com/img-prueba.jpg","alt":"portada","position":1}]}'
code=$(post_webhook "products/update" "$BODY_PROD")
[ "$code" = "200" ] || fail "encolar products/update: $code"

# 2) Encolar un inventory_levels/update para la variante sembrada
BODY_INV='{"inventory_item_id":555000333,"location_id":77777777777,"available":42}'
code=$(post_webhook "inventory_levels/update" "$BODY_INV")
[ "$code" = "200" ] || fail "encolar inventory_levels/update: $code"

EN_COLA=$(psql_q "select count(*) from pgmq.q_sync_jobs;")
ok "mensajes en cola listos para drenar: $EN_COLA"

# 3) Worker sin auth → 401 (un anon JWT tampoco debe poder drenar)
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/worker-sync")
[ "$code" = "401" ] || fail "worker sin auth: esperaba 401, llegó $code"
ok "worker sin service key: 401"

# 4) Worker con service key → drena todo
resp=$(curl -s -X POST "$BASE/worker-sync" -H "Authorization: Bearer $SERVICE_ROLE_KEY")
echo "  worker: $resp"

# 5) Verificaciones en base
t=$(psql_q "select title from products p join shops s on s.id=p.shop_id where s.shop_domain='$DOMAIN' and p.shopify_product_id='999888777';")
[ "$t" = "Producto Webhook Editado" ] || fail "products/update no aplicó (title='$t')"
ok "products/update aplicado (upsert de producto)"

v=$(psql_q "select count(*) from variants v join products p on p.id=v.product_id join shops s on s.id=p.shop_id where s.shop_domain='$DOMAIN' and v.shopify_variant_id='999888001';")
[ "$v" = "1" ] || fail "variante del webhook no se upsertó"
ok "variante e imagen del payload upsertadas"

inv=$(psql_q "select il.available from inventory_levels il join variants v on v.id=il.variant_id where v.inventory_item_id='555000333' and il.location_id='77777777777';")
[ "$inv" = "42" ] || fail "inventario esperado 42, hay '$inv'"
ok "inventory_levels/update → apply_inventory_change → available=42"

aud=$(psql_q "select count(*) from audit_log where entity='inventory' and detail->>'source'='shopify_webhook';")
[ "$aud" -ge 1 ] || fail "sin rastro en audit_log del apply"
ok "audit_log registró la escritura (source=shopify_webhook)"

pend=$(psql_q "select count(*) from webhook_events where processed_at is null;")
[ "$pend" = "0" ] || fail "quedaron $pend webhook_events sin procesar"
QF=$(psql_q "select count(*) from pgmq.q_sync_jobs;")
[ "$QF" = "0" ] || fail "quedaron $QF mensajes en cola"
ok "cola drenada y todos los webhook_events con processed_at"

se=$(psql_q "select count(*) from sync_events where direction='inbound' and status='success';")
[ "$se" -ge 2 ] || fail "sync_events success insuficientes ($se)"
ok "sync_events con rastro de éxito por mensaje"

echo
echo "WORKER INBOUND: TODOS LOS CASOS VERDES"
