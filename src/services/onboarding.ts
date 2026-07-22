import type { SupabaseClient } from "@supabase/supabase-js";
import {
  LOCATIONS_QUERY,
  SHOP_QUERY,
  TRACKING_SAMPLE_QUERY,
  type LocationsQueryData,
  type ShopQueryData,
  type TrackingSampleData,
} from "../graphql/onboarding.queries.js";
import { numericId } from "./gid.js";
import { ShopifyAuthError, shopifyGraphql } from "./shopify-client.js";

/** El alta se bloquea: se reportan TODAS las fallas y no se persiste nada. */
export class OnboardingBlockedError extends Error {
  constructor(readonly fallas: string[]) {
    super(`Alta bloqueada — requisito(s) sin cumplir:\n  - ${fallas.join("\n  - ")}`);
    this.name = "OnboardingBlockedError";
  }
}

export interface OnboardShopParams {
  artistId: string;
  shopDomain: string;
  accessToken: string;
  webhookSecret: string;
  /** id numérico o gid://shopify/Location/... */
  locationId: string;
}

export interface OnboardShopResult {
  shopId: string;
  created: boolean;
  locationName: string;
  trackedRatio: number;
}

const DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/**
 * Valida los 6 requisitos de la guía §2.2 y, SOLO si todos pasan, persiste
 * (secretos a Vault + fila en shops) vía create_shop_with_secrets (mig. 004).
 *
 *   1. shop URL con formato artista.myshopify.com
 *   2. Admin API token válido      ─┐ query `shop`: el token de una Custom App
 *   6. Custom App instalada        ─┘ solo funciona instalada; además se
 *      verifica que myshopifyDomain coincida (token de OTRA tienda = falla)
 *   3. webhook secret presente (verificable solo con el primer webhook real)
 *   4. location_id existe y está ACTIVA contra la API (guía: "verify early")
 *   5. inventory tracking ON por muestreo de variantes (docs/PENDIENTES.md #2)
 */
export async function onboardShop(
  supabase: SupabaseClient,
  params: OnboardShopParams,
): Promise<OnboardShopResult> {
  const fallas: string[] = [];
  const shopDomain = params.shopDomain.trim().toLowerCase();

  // Requisito 1 — sin dominio válido no hay a quién llamar: corta de una
  if (!DOMAIN_RE.test(shopDomain)) {
    throw new OnboardingBlockedError([
      `Dominio inválido: "${params.shopDomain}" (esperado: artista.myshopify.com)`,
    ]);
  }

  // Requisito 3 — no verificable contra la API; chequeo de presencia/forma
  if (params.webhookSecret.trim().length < 16) {
    fallas.push("Webhook secret ausente o demasiado corto (< 16 caracteres)");
  }

  // Requisitos 2 y 6 — token + app instalada
  let apiOk = false;
  try {
    const data = await shopifyGraphql<ShopQueryData>({
      shopDomain,
      accessToken: params.accessToken,
      query: SHOP_QUERY,
    });
    if (data.shop.myshopifyDomain.toLowerCase() === shopDomain) {
      apiOk = true;
    } else {
      fallas.push(`El token pertenece a otra tienda (${data.shop.myshopifyDomain})`);
    }
  } catch (e) {
    if (e instanceof ShopifyAuthError) {
      fallas.push("Token rechazado (401/403): inválido, revocado o Custom App no instalada");
    } else {
      fallas.push(`No se pudo validar el token contra la API: ${(e as Error).message}`);
    }
  }

  let locationName = "";
  let trackedRatio = 0;

  if (apiOk) {
    // Requisito 4 — la falla silenciosa más común en multi-tienda es escribir
    // a una location equivocada o desactivada (guía §2.2): verificar temprano.
    const wantedId = numericId(params.locationId);
    const locs = await shopifyGraphql<LocationsQueryData>({
      shopDomain,
      accessToken: params.accessToken,
      query: LOCATIONS_QUERY,
    });
    const loc = locs.locations.nodes.find((l) => numericId(l.id) === wantedId);
    if (!loc) {
      const disponibles = locs.locations.nodes
        .map((l) => `${numericId(l.id)} (${l.name}${l.isActive ? "" : ", inactiva"})`)
        .join(", ");
      fallas.push(`location_id ${wantedId} no existe en la tienda. Disponibles: ${disponibles || "ninguna"}`);
    } else if (!loc.isActive) {
      fallas.push(`La location ${wantedId} ("${loc.name}") está DESACTIVADA`);
    } else {
      locationName = loc.name;
    }

    // Requisito 5 — tracking por muestreo. Sin variantes no hay forma de
    // confirmarlo: se bloquea (dirección segura del invariante).
    const sample = await shopifyGraphql<TrackingSampleData>({
      shopDomain,
      accessToken: params.accessToken,
      query: TRACKING_SAMPLE_QUERY,
    });
    const total = sample.productVariants.nodes.length;
    const tracked = sample.productVariants.nodes.filter((v) => v.inventoryItem.tracked).length;
    if (total === 0) {
      fallas.push("La tienda no tiene variantes: imposible confirmar inventory tracking");
    } else if (tracked === 0) {
      fallas.push(`Ninguna de las ${total} variantes muestreadas tiene tracking activo`);
    } else {
      trackedRatio = tracked / total;
    }
  }

  if (fallas.length > 0) {
    throw new OnboardingBlockedError(fallas);
  }

  // Persistencia todo-o-nada (Vault + shops en una transacción, migración 004)
  const { data, error } = await supabase.rpc("create_shop_with_secrets", {
    p_artist_id: params.artistId,
    p_shop_domain: shopDomain,
    p_access_token: params.accessToken,
    p_webhook_secret: params.webhookSecret,
    p_location_id: numericId(params.locationId),
    p_inventory_tracked: true,
  });
  if (error) {
    throw new Error(`El alta falló al persistir: ${error.message}`);
  }

  const row = (data as Array<{ shop_id: string; created: boolean }>)[0];
  if (!row) {
    throw new Error("create_shop_with_secrets no devolvió fila");
  }

  return { shopId: row.shop_id, created: row.created, locationName, trackedRatio };
}
