// Registra los topics §6.1 para una tienda ya dada de alta.
// BUILD ORDER: correr DESPUÉS del import inicial (§5) — un webhook en vivo no
// debe llegar para un catálogo que nunca se importó.
//
// Uso:
//   npm run register-webhooks -- --shop-id <uuid> \
//     --callback-url https://<proyecto>.supabase.co/functions/v1/webhook

import { parseArgs } from "node:util";
import { createServiceClient } from "../src/services/supabase.js";
import { registerWebhooksForShop } from "../src/services/webhook-registration.js";

try {
  process.loadEnvFile();
} catch {
  /* sin .env */
}

const { values } = parseArgs({
  options: {
    "shop-id": { type: "string" },
    "callback-url": { type: "string" },
  },
});

const shopId = values["shop-id"];
const callbackUrl = values["callback-url"];
if (!shopId || !callbackUrl) {
  console.error("Requiere --shop-id y --callback-url");
  process.exit(2);
}
if (!callbackUrl.startsWith("https://")) {
  console.error("El callback debe ser https (Shopify rechaza http)");
  process.exit(2);
}

const supabase = createServiceClient();

// Aviso de BUILD ORDER: webhooks vivos solo con catálogo importado
const { count } = await supabase
  .from("products")
  .select("id", { count: "exact", head: true })
  .eq("shop_id", shopId);
if (!count) {
  console.warn(
    "⚠ La tienda no tiene productos importados. El BUILD ORDER manda: import inicial (§5) " +
      "antes de webhooks en vivo. Registrando de todas formas bajo tu responsabilidad…",
  );
}

const summary = await registerWebhooksForShop(supabase, shopId, callbackUrl);

for (const t of summary.registered) console.log(`✔ registrado      ${t}`);
for (const t of summary.alreadyPresent) console.log(`= ya existía      ${t}`);
for (const f of summary.failed) console.error(`✖ falló           ${f.topic}: ${f.error}`);

if (summary.failed.length > 0) process.exit(1);
