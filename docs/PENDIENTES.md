# PENDIENTES — dudas de API marcadas para validar (no inventar)

> Regla de la sesión: si un detalle de la API de Shopify genera duda, se marca aquí
> en vez de asumir. Validar contra la tienda de desarrollo.

## 1. `inventorySetQuantities` con `name: "available"` vs `on_hand` / `committed`

⚠ VALIDACIÓN PENDIENTE de `DECISIONES_TECNICAS_SYNC.md` (primera semana, tienda dev):
crear un pedido **sin cumplir** en la tienda de desarrollo y verificar que escribir
`available` se comporta como se espera con cantidades comprometidas. Es el escenario
exacto de sobreventa silenciosa. Documentar el resultado aquí y en /docs.

## 2. Verificación de "inventory tracking confirmado ON" (requisito 5 de §2.2)

Shopify no tiene un toggle de tracking a nivel tienda: `tracked` vive por
`InventoryItem` (variante). Interpretación implementada en el onboarding: muestrear
las primeras variantes del catálogo vía GraphQL y exigir que al menos una tenga
`inventoryItem.tracked = true`; se registra la proporción. Confirmar con el cliente
si el criterio debe ser más estricto (p. ej. 100 % de variantes tracked).

## 3. Payloads de webhooks en `2026-07`

Las formas de payload usadas (p. ej. `inventory_levels/update` con
`inventory_item_id`, `location_id`, `available`) siguen el shape REST histórico de
Shopify. Mi conocimiento llega hasta enero 2026: verificar contra el primer webhook
real de la tienda dev que los campos no cambiaron en `2026-07`, antes de dar por
buenos los handlers.

## 4. Productos con más de 50 variantes

La query de import (guía §5.2) trae `variants(first: 50)` anidado. El import pagina
variantes adicionales por producto cuando `hasNextPage = true`, pero Shopify ahora
permite hasta 2000 variantes/producto: si aparece un catálogo así, medir costo de
rate limit y considerar pasar ese producto a Bulk Operations.

## 5. Alerta real para dead-letter y `needs_reauth` (§10 guía)

Hoy "alertar" = fila en `sync_events` (status `dead_letter`) + log. Falta decidir el
canal real de alerta (email/Slack/otro) — no cubierto por los documentos.
