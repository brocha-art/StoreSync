// Topics en forma de header X-Shopify-Topic — la forma que se guarda en
// webhook_events.topic y por la que despacha el worker. La forma enum de
// GraphQL (PRODUCTS_UPDATE) vive en src/graphql/webhooks.mutations.ts.
//
// Los handlers ejecutables del worker viven junto a la Edge Function
// (supabase/functions/worker-sync/handlers.ts) porque el bundler de Edge
// Functions resuelve mejor módulos locales; si algún día duele la dualidad,
// extraer mappers compartidos vía import map.

export const TOPIC_HEADERS = [
  "products/create",
  "products/update",
  "products/delete",
  "inventory_levels/update",
  "orders/create",
  "orders/paid",
  "orders/cancelled",
  "fulfillments/update",
] as const;

export type TopicHeader = (typeof TOPIC_HEADERS)[number];
