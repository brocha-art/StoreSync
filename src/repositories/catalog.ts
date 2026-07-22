// Persistencia del catálogo importado (§5.1 pasos 2-3-5-6).
// El mapping Shopify↔plataforma ES estas tablas: uuid ↔ shopify_*_id.
// Inventario NO se escribe aquí: solo vía rpc apply_inventory_change.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProductoImportado } from "../services/catalog-source.js";

export interface ProductoPersistido {
  productId: string;
  /** inventory_item_id (numérico) -> uuid de la variante — insumo de la fase 2 */
  variantIdByInventoryItem: Map<string, string>;
}

export async function upsertProductoImportado(
  supabase: SupabaseClient,
  shopId: string,
  p: ProductoImportado,
): Promise<ProductoPersistido> {
  const nowIso = new Date().toISOString();

  const { data: prod, error } = await supabase
    .from("products")
    .upsert(
      {
        shop_id: shopId,
        shopify_product_id: p.shopifyProductId,
        title: p.title,
        handle: p.handle,
        description_html: p.descriptionHtml,
        status: p.status,
        deleted_at: null,
        updated_at: nowIso,
      },
      { onConflict: "shop_id,shopify_product_id" },
    )
    .select("id")
    .single();
  if (error || !prod) {
    throw new Error(`upsert product ${p.shopifyProductId}: ${error?.message ?? "sin fila"}`);
  }

  const variantIdByInventoryItem = new Map<string, string>();
  if (p.variants.length > 0) {
    const rows = p.variants.map((v) => ({
      product_id: prod.id,
      shopify_variant_id: v.shopifyVariantId,
      inventory_item_id: v.inventoryItemId,
      sku: v.sku,
      price: v.price,
    }));
    const { data: variants, error: vErr } = await supabase
      .from("variants")
      .upsert(rows, { onConflict: "product_id,shopify_variant_id" })
      .select("id, inventory_item_id");
    if (vErr) throw new Error(`upsert variants de ${p.shopifyProductId}: ${vErr.message}`);
    for (const v of variants ?? []) {
      variantIdByInventoryItem.set(v.inventory_item_id, v.id);
    }
  }

  if (p.images.length > 0) {
    const rows = p.images.map((img) => ({
      product_id: prod.id,
      shopify_image_id: img.shopifyImageId,
      url: img.url,
      alt_text: img.altText,
      position: img.position,
      updated_at: nowIso,
    }));
    const { error: iErr } = await supabase
      .from("product_images")
      .upsert(rows, { onConflict: "product_id,url" });
    if (iErr) throw new Error(`upsert images de ${p.shopifyProductId}: ${iErr.message}`);
  }

  return { productId: prod.id, variantIdByInventoryItem };
}
