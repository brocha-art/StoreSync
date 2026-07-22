# StoreSync — Sincronización bidireccional Shopify ↔ Supabase

Plataforma multi-tenant de sincronización (inventario, productos, órdenes e imágenes)
para múltiples tiendas independientes de artistas.

**Documentos rectores** (en la raíz del repo):

1. `Shopify_Supabase_Sync_Dev_Guide.docx` — guía del cliente (alcance, schema, flujos, BUILD ORDER, checklist §13).
2. `DECISIONES_TECNICAS_SYNC.md` — decisiones vinculantes. **Ante contradicción, gana este documento.**

**El invariante que gobierna todo: NUNCA sobrevender.** Ante cualquier trade-off, la
dirección segura es la que arriesga mostrar *menos* unidades disponibles, nunca más.

## ⚠ Recordatorio trimestral — versión de API de Shopify

La versión vive en **una sola constante**: [`src/config/shopify.ts`](src/config/shopify.ts)
(`SHOPIFY_API_VERSION`). Prohibido hardcodear la versión en URLs.

Cada release trimestral de Shopify (enero / abril / julio / octubre):

1. Correr la suite de tests del checklist (§13 de la guía) contra la versión nueva.
2. Solo si pasa, subir la constante y desplegar.

## Estado del proyecto

Ver [`docs/ESTADO.md`](docs/ESTADO.md) (qué está construido, qué falta, siguiente paso)
y [`docs/PENDIENTES.md`](docs/PENDIENTES.md) (dudas de API marcadas para validar).
