// Import inicial de catálogo (guía §5). BUILD ORDER: correr ANTES de
// registrar webhooks en vivo para la tienda.
//
// Uso:
//   npm run import-catalog -- --shop-id <uuid>

import { parseArgs } from "node:util";
import { importCatalog } from "../src/services/catalog-import.js";
import { markShopNeedsReauth } from "../src/services/reauth.js";
import { ShopifyAuthError } from "../src/services/shopify-client.js";
import { createServiceClient } from "../src/services/supabase.js";

try {
  process.loadEnvFile();
} catch {
  /* sin .env */
}

const { values } = parseArgs({
  options: { "shop-id": { type: "string" } },
});

const shopId = values["shop-id"];
if (!shopId) {
  console.error("Requiere --shop-id <uuid>");
  process.exit(2);
}

const supabase = createServiceClient();

try {
  const s = await importCatalog(supabase, shopId);
  console.log("✔ Import inicial completo");
  console.log(`  productos:   ${s.productos}${s.productosEnShopify !== null ? ` (Shopify reporta ${s.productosEnShopify})` : ""}`);
  console.log(`  variantes:   ${s.variantes}`);
  console.log(`  imágenes:    ${s.imagenes}`);
  console.log(`  inventarios: ${s.inventariosEscritos}`);
  for (const a of s.advertencias) console.warn(`  ⚠ ${a}`);
  if (s.advertencias.length === 0) {
    console.log("  sin advertencias — mapping completo, listo para registrar webhooks (§12.2)");
  }
} catch (e) {
  if (e instanceof ShopifyAuthError) {
    // §10: jamás reintentar auth; marcar, alertar, detener
    await markShopNeedsReauth(supabase, shopId, `import inicial: ${e.message}`);
    process.exit(1);
  }
  console.error(`✖ Import falló: ${(e as Error).message}`);
  process.exit(1);
}
