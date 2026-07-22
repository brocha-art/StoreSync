// ÚNICA fuente de la versión de API de Shopify (Decisión 1).
// Prohibido hardcodear la versión en una URL: todo llamado importa de aquí.
export const SHOPIFY_API_VERSION = "2026-07"; // Revisar trimestralmente (ene/abr/jul/oct) — ver README

export const shopifyGraphqlUrl = (shopDomain: string) =>
  `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
