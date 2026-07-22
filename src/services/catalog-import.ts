// Import inicial de catálogo (guía §5): productos → variantes (con
// inventory_item_id SIEMPRE) → imágenes → inventario por location primaria.
// Idempotente: correrlo dos veces converge al mismo estado (upserts + set).

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  INVENTORY_BATCH_QUERY,
  PRODUCTS_COUNT_QUERY,
  type InventoryBatchData,
  type ProductsCountData,
} from "../graphql/products.query.js";
import type { ShopCredentials } from "../types/index.js";
import { PaginatedCatalogSource, type CatalogSource } from "./catalog-source.js";
import { toGid } from "./gid.js";
import { shopifyGraphql } from "./shopify-client.js";
import { upsertProductoImportado } from "../repositories/catalog.js";

export interface ImportSummary {
  productos: number;
  variantes: number;
  imagenes: number;
  inventariosEscritos: number;
  productosEnShopify: number | null;
  advertencias: string[];
}

const INVENTORY_BATCH = 100;

export async function importCatalog(
  supabase: SupabaseClient,
  shopId: string,
  source?: CatalogSource,
): Promise<ImportSummary> {
  // La tienda debe estar operable: needs_reauth/paused detiene sus jobs (§10)
  const { data: shop, error: shopErr } = await supabase
    .from("shops")
    .select("status")
    .eq("id", shopId)
    .single();
  if (shopErr || !shop) throw new Error(`Tienda ${shopId} no existe: ${shopErr?.message ?? ""}`);
  if (shop.status !== "active") {
    throw new Error(`Tienda ${shopId} en estado '${shop.status}': import bloqueado (§10)`);
  }

  const { data: credsRows, error: credsErr } = await supabase.rpc("get_shop_credentials", {
    p_shop_id: shopId,
  });
  const creds = credsRows?.[0] as ShopCredentials | undefined;
  if (credsErr || !creds) {
    throw new Error(`Sin credenciales para ${shopId}: ${credsErr?.message ?? "sin fila"}`);
  }

  const src = source ?? new PaginatedCatalogSource(creds.shop_domain, creds.access_token);
  const summary: ImportSummary = {
    productos: 0,
    variantes: 0,
    imagenes: 0,
    inventariosEscritos: 0,
    productosEnShopify: null,
    advertencias: [],
  };

  for await (const pagina of src.fetchCatalog()) {
    // Fase 1 (página): upsert de productos/variantes/imágenes + mapping
    const itemToVariant = new Map<string, string>();
    for (const p of pagina) {
      const persisted = await upsertProductoImportado(supabase, shopId, p);
      summary.productos++;
      summary.variantes += p.variants.length;
      summary.imagenes += p.images.length;
      for (const [item, variantId] of persisted.variantIdByInventoryItem) {
        itemToVariant.set(item, variantId);
      }
      if (p.variants.length > 50) {
        summary.advertencias.push(
          `Producto ${p.shopifyProductId}: ${p.variants.length} variantes (candidato a Bulk §5.3)`,
        );
      }
    }

    // Fase 2 (página): available POR la location primaria, en lotes (§5.1 paso 4)
    const items = [...itemToVariant.keys()];
    for (let i = 0; i < items.length; i += INVENTORY_BATCH) {
      const lote = items.slice(i, i + INVENTORY_BATCH);
      const data = await shopifyGraphql<InventoryBatchData>({
        shopDomain: creds.shop_domain,
        accessToken: creds.access_token,
        query: INVENTORY_BATCH_QUERY,
        variables: {
          ids: lote.map((id) => toGid("InventoryItem", id)),
          locationId: toGid("Location", creds.location_id),
        },
      });

      for (const node of data.nodes) {
        if (!node || node.__typename !== "InventoryItem" || !node.id) continue;
        const itemId = node.id.split("/").pop() ?? "";
        const variantId = itemToVariant.get(itemId);
        if (!variantId) continue;

        const qty = node.inventoryLevel?.quantities.find((q) => q.name === "available")?.quantity;
        if (typeof qty !== "number") {
          // Item sin nivel en la location primaria: NO inventar un número.
          // Sin fila = no vendible aquí — la dirección segura (mostrar menos).
          summary.advertencias.push(
            `inventory_item ${itemId} sin nivel 'available' en la location primaria: no escrito`,
          );
          continue;
        }

        const { error: applyErr } = await supabase.rpc("apply_inventory_change", {
          p_variant_id: variantId,
          p_location_id: creds.location_id,
          p_new_available: qty,
          p_source: "initial_import",
        });
        if (applyErr) {
          throw new Error(`apply_inventory_change ${variantId}: ${applyErr.message}`);
        }
        summary.inventariosEscritos++;
      }
    }
  }

  // Completitud del mapping (§12.2 paso 3): comparar contra productsCount
  try {
    const countData = await shopifyGraphql<ProductsCountData>({
      shopDomain: creds.shop_domain,
      accessToken: creds.access_token,
      query: PRODUCTS_COUNT_QUERY,
    });
    summary.productosEnShopify = countData.productsCount?.count ?? null;
    if (
      summary.productosEnShopify !== null &&
      summary.productosEnShopify !== summary.productos
    ) {
      summary.advertencias.push(
        `Completitud: Shopify reporta ${summary.productosEnShopify} productos, importados ${summary.productos}`,
      );
    }
  } catch (e) {
    summary.advertencias.push(`No se pudo verificar productsCount: ${(e as Error).message}`);
  }

  // Rastro de observabilidad del import completo
  await supabase.from("sync_events").insert({
    shop_id: shopId,
    direction: "inbound",
    entity: "product",
    status: "success",
    payload: { import_inicial: true, ...summary, advertencias: summary.advertencias.slice(0, 20) },
  });

  return summary;
}
