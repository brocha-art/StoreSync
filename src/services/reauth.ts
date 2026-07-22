import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Invariante §10: un 401/403 de Shopify JAMÁS se reintenta.
 * Marca la tienda needs_reauth (sus jobs dejan de correr: el import y los
 * workers outbound verifican status='active' antes de operar), deja rastro
 * en audit_log y "alerta" (hoy: stderr; canal real en PENDIENTES #5).
 * La tienda vuelve a 'active' SOLO por onboarding con token nuevo.
 */
export async function markShopNeedsReauth(
  supabase: SupabaseClient,
  shopId: string,
  motivo: string,
): Promise<void> {
  const { error } = await supabase
    .from("shops")
    .update({ status: "needs_reauth" })
    .eq("id", shopId);
  if (error) {
    console.error(`No se pudo marcar needs_reauth para ${shopId}: ${error.message}`);
  }
  await supabase.from("audit_log").insert({
    shop_id: shopId,
    entity: "shop",
    entity_id: shopId,
    action: "needs_reauth",
    detail: { motivo },
  });
  console.error(`⚠ ALERTA: tienda ${shopId} marcada needs_reauth — ${motivo}`);
}
