// Receptor de webhooks de Shopify (guía §6.3): verificar → persistir crudo →
// encolar → 200 rápido. El trabajo pesado lo hace el worker (paso 7); Shopify
// reintenta todo lo que no sea 2xx.
//
// Respuestas deliberadamente idénticas (401) para dominio desconocido, secreto
// ausente y HMAC inválido: el endpoint no es un oráculo de qué tiendas existen.

import { createClient } from "npm:@supabase/supabase-js@2";
import { verifyWebhook } from "./verify.ts";

// service_role: SOLO existe dentro de esta función server-side (§11)
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  // 1. Body CRUDO (no parseado): el HMAC es sobre los bytes crudos
  const raw = await req.text();
  const hmac = req.headers.get("X-Shopify-Hmac-Sha256") ?? "";
  const eventId = req.headers.get("X-Shopify-Webhook-Id");
  const topic = req.headers.get("X-Shopify-Topic");
  const domain = req.headers.get("X-Shopify-Shop-Domain");

  if (!eventId || !topic || !domain) {
    return new Response("unauthorized", { status: 401 });
  }

  // 2. Tienda por dominio (los webhooks se aceptan aunque esté needs_reauth:
  //    el inbound no usa el token y mantener el espejo al día es lo seguro)
  const { data: shop } = await supabase
    .from("shops")
    .select("id")
    .eq("shop_domain", domain.toLowerCase())
    .maybeSingle();
  if (!shop) {
    return new Response("unauthorized", { status: 401 });
  }

  // 3. Webhook secret desde Vault — vive solo en memoria durante el request
  const { data: creds } = await supabase.rpc("get_shop_credentials", { p_shop_id: shop.id });
  const secret: string | undefined = creds?.[0]?.webhook_secret;
  if (!secret || !verifyWebhook(raw, hmac, secret)) {
    return new Response("unauthorized", { status: 401 });
  }

  // 4+5. Persistir + dedupe + encolar, atómico (migración 005).
  //      Duplicado => was_new=false: se descarta sin re-encolar.
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response("bad request", { status: 400 });
  }

  const { data: ingest, error } = await supabase.rpc("ingest_webhook_event", {
    p_shop_id: shop.id,
    p_topic: topic,
    p_shopify_event_id: eventId,
    p_payload: payload,
  });
  if (error) {
    // 500 => Shopify reintenta; nada quedó escrito (la ingesta es atómica)
    console.error(`ingesta fallida shop=${shop.id} topic=${topic}: ${error.message}`);
    return new Response("error", { status: 500 });
  }

  const wasNew: boolean = ingest?.[0]?.was_new ?? false;
  return new Response(wasNew ? "ok" : "ok (duplicate)", { status: 200 });
});
