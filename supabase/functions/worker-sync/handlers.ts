// Handlers por topic del worker inbound (guía §7.1).
// Los payloads son las formas REST de los webhooks de Shopify
// (ver docs/PENDIENTES.md #3: confirmar contra 2026-07 con la tienda dev).
//
// Reglas:
// - Multi-tenant: TODO lookup se scopea por el shop_id del webhook autenticado.
// - Inventario: JAMÁS se escribe inventory_levels directo; solo el RPC
//   apply_inventory_change (advisory lock por variante — Decisión 3).
// - Órdenes espejo SIN tocar inventario: Shopify emite su propio
//   inventory_levels/update por la venta (evita doble descuento).
// - Idempotencia: upserts + set absoluto => re-procesar un mensaje es inocuo.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

interface ProductPayload {
  id: number | string;
  title?: string;
  handle?: string;
  body_html?: string;
  status?: string;
  variants?: Array<{
    id: number | string;
    sku?: string | null;
    price?: string | number | null;
    inventory_item_id?: number | string;
  }>;
  images?: Array<{
    id?: number | string;
    src?: string;
    alt?: string | null;
    position?: number;
  }>;
}

interface InventoryPayload {
  inventory_item_id?: number | string;
  location_id?: number | string;
  available?: number | null;
}

interface OrderPayload {
  id: number | string;
  financial_status?: string | null;
  fulfillment_status?: string | null;
  currency?: string | null;
  total_price?: string | number | null;
  created_at?: string | null;
  cancelled_at?: string | null;
  line_items?: Array<{
    id: number | string;
    variant_id?: number | string | null;
    sku?: string | null;
    title?: string | null;
    quantity?: number;
    price?: string | number | null;
  }>;
}

interface FulfillmentPayload {
  order_id?: number | string;
  status?: string | null;
}

/** Detalle que termina en sync_events.payload (p. ej. variant_id para la Decisión 5). */
export type HandlerDetail = Record<string, unknown>;

function must<T>(v: T | null | undefined, msg: string): T {
  if (v === null || v === undefined) throw new Error(msg);
  return v;
}

async function productUpsert(
  supabase: SupabaseClient,
  shopId: string,
  p: ProductPayload,
): Promise<HandlerDetail> {
  const nowIso = new Date().toISOString();
  const { data: prod, error } = await supabase
    .from("products")
    .upsert(
      {
        shop_id: shopId,
        shopify_product_id: String(p.id),
        title: p.title ?? null,
        handle: p.handle ?? null,
        description_html: p.body_html ?? null,
        status: p.status?.toLowerCase() ?? null,
        deleted_at: null, // un update de Shopify revive un soft-delete previo
        updated_at: nowIso,
      },
      { onConflict: "shop_id,shopify_product_id" },
    )
    .select("id")
    .single();
  if (error || !prod) throw new Error(`upsert product: ${error?.message ?? "sin fila"}`);

  if (p.variants && p.variants.length > 0) {
    const rows = p.variants
      .filter((v) => v.inventory_item_id !== undefined && v.inventory_item_id !== null)
      .map((v) => ({
        product_id: prod.id,
        shopify_variant_id: String(v.id),
        inventory_item_id: String(v.inventory_item_id),
        sku: v.sku ?? null,
        price: v.price ?? null,
      }));
    if (rows.length > 0) {
      const { error: vErr } = await supabase
        .from("variants")
        .upsert(rows, { onConflict: "product_id,shopify_variant_id" });
      if (vErr) throw new Error(`upsert variants: ${vErr.message}`);
    }
  }

  if (p.images && p.images.length > 0) {
    const rows = p.images
      .filter((img) => typeof img.src === "string" && img.src.length > 0)
      .map((img, i) => ({
        product_id: prod.id,
        shopify_image_id: img.id !== undefined ? String(img.id) : null,
        url: img.src as string,
        alt_text: img.alt ?? null,
        position: img.position ?? i,
        updated_at: nowIso,
      }));
    if (rows.length > 0) {
      const { error: iErr } = await supabase
        .from("product_images")
        .upsert(rows, { onConflict: "product_id,url" });
      if (iErr) throw new Error(`upsert images: ${iErr.message}`);
    }
  }

  return { product_id: prod.id, shopify_product_id: String(p.id) };
}

async function productDelete(
  supabase: SupabaseClient,
  shopId: string,
  p: ProductPayload,
): Promise<HandlerDetail> {
  // Soft-delete local (guía §6.1, checklist #3): marcado, no huérfano
  const { data, error } = await supabase
    .from("products")
    .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("shop_id", shopId)
    .eq("shopify_product_id", String(p.id))
    .select("id");
  if (error) throw new Error(`soft-delete product: ${error.message}`);
  return { shopify_product_id: String(p.id), soft_deleted: (data ?? []).length > 0 };
}

async function inventoryUpdate(
  supabase: SupabaseClient,
  shopId: string,
  p: InventoryPayload,
): Promise<HandlerDetail> {
  const itemId = String(must(p.inventory_item_id, "payload sin inventory_item_id"));
  const locationId = String(must(p.location_id, "payload sin location_id"));
  const available = p.available;
  if (typeof available !== "number") {
    // null = item sin tracking o sin stock en la location: no inventar números
    throw new Error(`available no numérico para inventory_item_id=${itemId}`);
  }

  const { data: variant, error } = await supabase
    .from("variants")
    .select("id, products!inner(shop_id)")
    .eq("inventory_item_id", itemId)
    .eq("products.shop_id", shopId)
    .maybeSingle();
  if (error) throw new Error(`lookup variante: ${error.message}`);
  if (!variant) {
    // Alimenta la ventana de reconciliación dirigida (Decisión 5) como failed
    throw new Error(`variante desconocida para inventory_item_id=${itemId} (¿falta import?)`);
  }

  const { data: qty, error: applyErr } = await supabase.rpc("apply_inventory_change", {
    p_variant_id: variant.id,
    p_location_id: locationId,
    p_new_available: available,
    p_source: "shopify_webhook",
  });
  if (applyErr) throw new Error(`apply_inventory_change: ${applyErr.message}`);

  return { variant_id: variant.id, available: qty };
}

async function orderUpsert(
  supabase: SupabaseClient,
  shopId: string,
  o: OrderPayload,
): Promise<HandlerDetail> {
  const nowIso = new Date().toISOString();
  const { data: order, error } = await supabase
    .from("orders")
    .upsert(
      {
        shop_id: shopId,
        shopify_order_id: String(o.id),
        source: "shopify",
        financial_status: o.financial_status ?? null,
        fulfillment_status: o.fulfillment_status ?? null,
        currency: o.currency ?? null,
        total_amount: o.total_price ?? null,
        shopify_created_at: o.created_at ?? null,
        cancelled_at: o.cancelled_at ?? null,
        updated_at: nowIso,
      },
      { onConflict: "shop_id,shopify_order_id" },
    )
    .select("id")
    .single();
  if (error || !order) throw new Error(`upsert order: ${error?.message ?? "sin fila"}`);

  const items = o.line_items ?? [];
  if (items.length > 0) {
    // Mapear shopify_variant_id -> uuid local, SIEMPRE scopeado a la tienda
    const variantIds = items
      .filter((li) => li.variant_id !== null && li.variant_id !== undefined)
      .map((li) => String(li.variant_id));
    const byShopifyId = new Map<string, string>();
    if (variantIds.length > 0) {
      const { data: found, error: vErr } = await supabase
        .from("variants")
        .select("id, shopify_variant_id, products!inner(shop_id)")
        .eq("products.shop_id", shopId)
        .in("shopify_variant_id", variantIds);
      if (vErr) throw new Error(`lookup variantes de la orden: ${vErr.message}`);
      for (const v of found ?? []) byShopifyId.set(v.shopify_variant_id, v.id);
    }

    const rows = items.map((li) => ({
      order_id: order.id,
      variant_id:
        li.variant_id !== null && li.variant_id !== undefined
          ? (byShopifyId.get(String(li.variant_id)) ?? null)
          : null,
      shopify_line_item_id: String(li.id),
      sku: li.sku ?? null,
      title: li.title ?? null,
      quantity: li.quantity ?? 0,
      price: li.price ?? null,
    }));
    const { error: liErr } = await supabase
      .from("order_items")
      .upsert(rows, { onConflict: "order_id,shopify_line_item_id" });
    if (liErr) throw new Error(`upsert order_items: ${liErr.message}`);
  }

  return { order_id: order.id, shopify_order_id: String(o.id), items: items.length };
}

async function fulfillmentUpdate(
  supabase: SupabaseClient,
  shopId: string,
  f: FulfillmentPayload,
): Promise<HandlerDetail> {
  const orderId = String(must(f.order_id, "payload sin order_id"));
  const { error } = await supabase
    .from("orders")
    .update({ fulfillment_status: f.status ?? null, updated_at: new Date().toISOString() })
    .eq("shop_id", shopId)
    .eq("shopify_order_id", orderId);
  if (error) throw new Error(`fulfillment update: ${error.message}`);
  return { shopify_order_id: orderId, fulfillment_status: f.status ?? null };
}

/** Despacho por topic (forma header: "products/update"). Lanza en cualquier falla. */
export async function procesarEvento(
  supabase: SupabaseClient,
  shopId: string,
  topic: string,
  payload: unknown,
): Promise<HandlerDetail> {
  switch (topic) {
    case "products/create":
    case "products/update":
      return await productUpsert(supabase, shopId, payload as ProductPayload);
    case "products/delete":
      return await productDelete(supabase, shopId, payload as ProductPayload);
    case "inventory_levels/update":
      return await inventoryUpdate(supabase, shopId, payload as InventoryPayload);
    case "orders/create":
    case "orders/paid":
    case "orders/cancelled":
      return await orderUpsert(supabase, shopId, payload as OrderPayload);
    case "fulfillments/update":
      return await fulfillmentUpdate(supabase, shopId, payload as FulfillmentPayload);
    default:
      // Topic no registrado por nosotros: no romper, dejar rastro
      return { ignorado: true, topic };
  }
}
