// Shopify GraphQL habla en GIDs (gid://shopify/Location/456); los webhooks
// REST traen ids numéricos (456). Convención del proyecto: en la base de
// datos SIEMPRE el id numérico como texto; el GID se construye únicamente
// en la frontera GraphQL con estas utilidades.

const GID_RE = /^gid:\/\/shopify\/(\w+)\/(\d+)$/;

export type ShopifyGidType =
  | "Product"
  | "ProductVariant"
  | "InventoryItem"
  | "Location"
  | "Order";

/** Acepta gid o id numérico; devuelve siempre el id numérico como texto. */
export function numericId(idOrGid: string | number): string {
  const s = String(idOrGid);
  const m = GID_RE.exec(s);
  if (m?.[2]) return m[2];
  if (/^\d+$/.test(s)) return s;
  throw new Error(`Id de Shopify no reconocido: ${s}`);
}

export function toGid(type: ShopifyGidType, idOrGid: string | number): string {
  return `gid://shopify/${type}/${numericId(idOrGid)}`;
}
