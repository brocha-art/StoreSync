import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CREATE_WEBHOOK_MUTATION,
  LIST_WEBHOOKS_QUERY,
  WEBHOOK_TOPICS,
  type CreateWebhookData,
  type ListWebhooksData,
  type WebhookTopic,
} from "../graphql/webhooks.mutations.js";
import type { ShopCredentials } from "../types/index.js";
import { shopifyGraphql } from "./shopify-client.js";

export interface RegistrationSummary {
  registered: WebhookTopic[];
  alreadyPresent: WebhookTopic[];
  failed: Array<{ topic: WebhookTopic; error: string }>;
}

/**
 * Registra los 8 topics de la guía §6.1 apuntando al receptor. Idempotente:
 * lista las suscripciones existentes y crea solo las faltantes para ese
 * callbackUrl. Se corre DESPUÉS del import inicial (BUILD ORDER: un webhook
 * no debe llegar antes de que exista el catálogo).
 */
export async function registerWebhooksForShop(
  supabase: SupabaseClient,
  shopId: string,
  callbackUrl: string,
): Promise<RegistrationSummary> {
  const { data: credsRows, error } = await supabase.rpc("get_shop_credentials", {
    p_shop_id: shopId,
  });
  if (error || !credsRows?.[0]) {
    throw new Error(`No hay credenciales para la tienda ${shopId}: ${error?.message ?? "sin fila"}`);
  }
  const creds = credsRows[0] as ShopCredentials;

  // Suscripciones ya existentes para este callback (paginado por si hay muchas)
  const existentes = new Set<string>();
  let cursor: string | null = null;
  do {
    const page: ListWebhooksData = await shopifyGraphql<ListWebhooksData>({
      shopDomain: creds.shop_domain,
      accessToken: creds.access_token,
      query: LIST_WEBHOOKS_QUERY,
      variables: { cursor },
    });
    for (const node of page.webhookSubscriptions.nodes) {
      if (node.endpoint.callbackUrl === callbackUrl) {
        existentes.add(node.topic);
      }
    }
    cursor = page.webhookSubscriptions.pageInfo.hasNextPage
      ? page.webhookSubscriptions.pageInfo.endCursor
      : null;
  } while (cursor);

  const summary: RegistrationSummary = { registered: [], alreadyPresent: [], failed: [] };

  for (const topic of WEBHOOK_TOPICS) {
    if (existentes.has(topic)) {
      summary.alreadyPresent.push(topic);
      continue;
    }
    const data = await shopifyGraphql<CreateWebhookData>({
      shopDomain: creds.shop_domain,
      accessToken: creds.access_token,
      query: CREATE_WEBHOOK_MUTATION,
      variables: { topic, sub: { callbackUrl, format: "JSON" } },
    });
    const errs = data.webhookSubscriptionCreate.userErrors;
    if (errs.length > 0) {
      // "address … already taken" = ya registrado (carrera benigna): contar como presente
      if (errs.some((e) => /taken/i.test(e.message))) {
        summary.alreadyPresent.push(topic);
      } else {
        summary.failed.push({ topic, error: errs.map((e) => e.message).join("; ") });
      }
    } else {
      summary.registered.push(topic);
    }
  }

  return summary;
}
