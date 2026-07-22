#!/usr/bin/env bash
# Prueba local del receptor de webhooks — checklist §13: #8 (duplicado una sola
# vez) y #9 (HMAC malo rechazado sin escribir).
#
# Requiere: stack local arriba, migraciones aplicadas, tienda de prueba
# sembrada (tests/seed_tienda_prueba.sql) y `supabase functions serve` activo.
#
# Uso: bash tests/test_receptor_webhooks.sh [URL_BASE]
set -euo pipefail

BASE_URL="${1:-http://127.0.0.1:55321/functions/v1/webhook}"
SECRET='whsec_prueba_1234567890'   # solo pruebas locales (ver seed)
DOMAIN='prueba-local.myshopify.com'

psql_q() { docker exec supabase_db_StoreSync psql -U postgres -d postgres -tA -c "$1"; }
fail() { echo "✖ $1"; exit 1; }
ok()   { echo "✔ $1"; }

BODY='{"id":999888777,"title":"Producto Webhook Prueba","status":"active"}'
EVENT_ID="test-evt-$RANDOM$RANDOM"
HMAC_OK=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -binary | base64)

post() { # $1=hmac  $2=event_id  $3=dominio
  curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL" \
    -H "Content-Type: application/json" \
    -H "X-Shopify-Shop-Domain: ${3:-$DOMAIN}" \
    -H "X-Shopify-Topic: products/update" \
    -H "X-Shopify-Webhook-Id: ${2:-$EVENT_ID}" \
    -H "X-Shopify-Hmac-Sha256: $1" \
    -d "$BODY"
}

Q0=$(psql_q "select count(*) from pgmq.q_sync_jobs;")

# 1) HMAC válido → 200, fila única, mensaje encolado
code=$(post "$HMAC_OK")
[ "$code" = "200" ] || fail "caso 1: esperaba 200, llegó $code"
n=$(psql_q "select count(*) from webhook_events where shopify_event_id='$EVENT_ID';")
[ "$n" = "1" ] || fail "caso 1: filas=$n (esperaba 1)"
Q1=$(psql_q "select count(*) from pgmq.q_sync_jobs;")
[ "$Q1" = "$((Q0 + 1))" ] || fail "caso 1: no se encoló (cola $Q0 -> $Q1)"
ok "HMAC válido: 200 + fila + mensaje encolado"

# 2) Replay del MISMO X-Shopify-Webhook-Id → 200, sin duplicar ni re-encolar (checklist #8)
code=$(post "$HMAC_OK")
[ "$code" = "200" ] || fail "caso 2: esperaba 200, llegó $code"
n=$(psql_q "select count(*) from webhook_events where shopify_event_id='$EVENT_ID';")
[ "$n" = "1" ] || fail "caso 2: el replay duplicó la fila (filas=$n)"
Q2=$(psql_q "select count(*) from pgmq.q_sync_jobs;")
[ "$Q2" = "$Q1" ] || fail "caso 2: el replay re-encoló (cola $Q1 -> $Q2)"
ok "checklist #8: duplicado descartado antes de tocar datos"

# 3) HMAC inválido → 401 y NADA escrito (checklist #9)
EVT_MALO="test-evt-malo-$RANDOM"
code=$(post "aW52YWxpZG8xMjM0NTY3ODkwMTIzNDU2Nzg5MDEyMzQ1Ng==" "$EVT_MALO")
[ "$code" = "401" ] || fail "caso 3: esperaba 401, llegó $code"
n=$(psql_q "select count(*) from webhook_events where shopify_event_id='$EVT_MALO';")
[ "$n" = "0" ] || fail "caso 3: escribió con HMAC malo"
Q3=$(psql_q "select count(*) from pgmq.q_sync_jobs;")
[ "$Q3" = "$Q2" ] || fail "caso 3: encoló con HMAC malo"
ok "checklist #9: HMAC inválido → 401, nada escrito, nada encolado"

# 4) Dominio desconocido → mismo 401 (sin oráculo de tiendas)
code=$(post "$HMAC_OK" "test-evt-desconocido-$RANDOM" "nadie.myshopify.com")
[ "$code" = "401" ] || fail "caso 4: esperaba 401, llegó $code"
ok "dominio desconocido: 401 idéntico (sin oráculo)"

echo
echo "RECEPTOR: TODOS LOS CASOS VERDES"
