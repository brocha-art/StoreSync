// Panel visual de SOLO LECTURA para ver el estado de la sincronización:
// productos espejados, variantes con stock, tiendas y salud del sync.
//
// Seguridad (§11): corre server-side y entrega HTML ya renderizado — el
// service_role JAMÁS llega al navegador. Escucha SOLO en 127.0.0.1.
// El acceso externo "de verdad" será el API gateway (Decisión 6); esto es
// una herramienta de operación local.
//
// Uso:
//   npm run panel                          → http://127.0.0.1:8787 (datos del .env)
//   npm run panel -- --env .env.local      → stack local
//   npm run panel -- --env .env.cloud      → producción
//   PANEL_PORT=9000 npm run panel          → otro puerto

import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { createServiceClient } from "../src/services/supabase.js";

const { values: args } = parseArgs({ options: { env: { type: "string" } } });
try {
  process.loadEnvFile(args.env ?? ".env");
} catch {
  /* sin archivo env: las vars deben venir del entorno */
}

const PORT = Number(process.env["PANEL_PORT"] ?? 8787);
const HOST_DB = new URL(process.env["SUPABASE_URL"] ?? "http://desconocido").host;
const supabase = createServiceClient();

const esc = (s: unknown): string =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );

interface ShopRow {
  id: string;
  shop_domain: string;
  status: string;
  location_id: string;
}

interface ProductRow {
  id: string;
  shop_id: string;
  title: string | null;
  status: string | null;
  handle: string | null;
  deleted_at: string | null;
  updated_at: string | null;
  product_images: Array<{ url: string; position: number }>;
  variants: Array<{
    sku: string | null;
    price: string | null;
    shopify_variant_id: string;
    inventory_item_id: string;
    inventory_levels: Array<{ available: number; location_id: string }>;
  }>;
}

interface SyncEventRow {
  created_at: string;
  direction: string;
  entity: string;
  status: string;
  error: string | null;
}

function stockBadge(v: ProductRow["variants"][number]): string {
  const lvl = v.inventory_levels[0];
  if (!lvl) return `<span class="chip gris">sin nivel</span>`;
  const n = lvl.available;
  const clase = n <= 0 ? "rojo" : n <= 5 ? "ambar" : "verde";
  return `<span class="chip ${clase}">${n} disp.</span>`;
}

async function renderPage(shopFilter: string | null): Promise<string> {
  const { data: shopsData, error: shopsErr } = await supabase
    .from("shops")
    .select("id, shop_domain, status, location_id")
    .order("created_at");
  if (shopsErr) throw new Error(shopsErr.message);
  const shops = (shopsData ?? []) as ShopRow[];

  const conteos = new Map<string, number>();
  for (const s of shops) {
    const { count } = await supabase
      .from("products")
      .select("id", { count: "exact", head: true })
      .eq("shop_id", s.id);
    conteos.set(s.id, count ?? 0);
  }

  let prodQuery = supabase
    .from("products")
    .select(
      "id, shop_id, title, status, handle, deleted_at, updated_at, product_images(url, position), variants(sku, price, shopify_variant_id, inventory_item_id, inventory_levels(available, location_id))",
    )
    .order("updated_at", { ascending: false })
    .limit(60);
  if (shopFilter) prodQuery = prodQuery.eq("shop_id", shopFilter);
  const { data: prodData, error: prodErr } = await prodQuery;
  if (prodErr) throw new Error(prodErr.message);
  const productos = (prodData ?? []) as unknown as ProductRow[];

  let pendQuery = supabase
    .from("webhook_events")
    .select("id", { count: "exact", head: true })
    .is("processed_at", null);
  if (shopFilter) pendQuery = pendQuery.eq("shop_id", shopFilter);
  const { count: pendientes } = await pendQuery;

  let evQuery = supabase
    .from("sync_events")
    .select("created_at, direction, entity, status, error")
    .order("created_at", { ascending: false })
    .limit(10);
  if (shopFilter) evQuery = evQuery.eq("shop_id", shopFilter);
  const { data: evData } = await evQuery;
  const eventos = (evData ?? []) as SyncEventRow[];

  const domPorShop = new Map(shops.map((s) => [s.id, s.shop_domain]));

  const shopCards = shops
    .map((s) => {
      const activa = shopFilter === s.id;
      const st =
        s.status === "active"
          ? `<span class="chip verde">activa</span>`
          : `<span class="chip rojo">${esc(s.status)}</span>`;
      return `<a class="tienda${activa ? " sel" : ""}" href="/?shop=${esc(s.id)}">
        <strong>${esc(s.shop_domain)}</strong>
        <span>${conteos.get(s.id) ?? 0} productos · location ${esc(s.location_id)}</span>
        ${st}
      </a>`;
    })
    .join("");

  const prodCards = productos
    .map((p) => {
      const img = [...p.product_images].sort((a, b) => a.position - b.position)[0];
      const filas = p.variants
        .map(
          (v) => `<tr>
            <td>${esc(v.sku ?? v.shopify_variant_id)}</td>
            <td>${v.price != null ? "$" + esc(v.price) : "—"}</td>
            <td>${stockBadge(v)}</td>
          </tr>`,
        )
        .join("");
      return `<article class="prod${p.deleted_at ? " borrado" : ""}">
        <div class="thumb">${img ? `<img src="${esc(img.url)}" alt="" loading="lazy">` : `<div class="noimg">sin imagen</div>`}</div>
        <div class="info">
          <h3>${esc(p.title ?? "(sin título)")}</h3>
          <p class="meta">${esc(domPorShop.get(p.shop_id) ?? "")} · ${esc(p.status ?? "?")}${p.deleted_at ? ` · <span class="chip rojo">eliminado en Shopify</span>` : ""}</p>
          <table>${filas || `<tr><td colspan="3" class="meta">sin variantes</td></tr>`}</table>
        </div>
      </article>`;
    })
    .join("");

  const evFilas = eventos
    .map(
      (e) => `<tr>
        <td>${esc(new Date(e.created_at).toLocaleTimeString("es", { hour12: false }))}</td>
        <td>${esc(e.direction)}/${esc(e.entity)}</td>
        <td><span class="chip ${e.status === "success" ? "verde" : e.status === "dead_letter" ? "rojo" : "ambar"}">${esc(e.status)}</span></td>
        <td class="meta">${esc(e.error ?? "")}</td>
      </tr>`,
    )
    .join("");

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="30">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>StoreSync — panel</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 -apple-system, "Segoe UI", sans-serif; background: #f4f3ef; color: #1e1e1c; }
  header { background: #16211c; color: #e9efe9; padding: 14px 22px; display: flex; gap: 14px; align-items: baseline; flex-wrap: wrap; }
  header h1 { font-size: 17px; margin: 0; font-weight: 600; }
  header .meta { color: #9db3a6; font-size: 13px; }
  main { max-width: 1100px; margin: 0 auto; padding: 18px 22px 40px; }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .06em; color: #6d6d66; margin: 26px 0 10px; }
  .tiendas { display: flex; gap: 12px; flex-wrap: wrap; }
  .tienda { background: #fff; border: 1px solid #dcdad2; border-radius: 10px; padding: 12px 16px; text-decoration: none; color: inherit; display: grid; gap: 3px; min-width: 250px; }
  .tienda span { font-size: 13px; color: #6d6d66; }
  .tienda.sel { border-color: #1d9e75; outline: 2px solid #1d9e7533; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 14px; }
  .prod { background: #fff; border: 1px solid #dcdad2; border-radius: 10px; overflow: hidden; display: flex; }
  .prod.borrado { opacity: .55; }
  .thumb { width: 96px; min-width: 96px; background: #eceae3; display: flex; align-items: center; justify-content: center; }
  .thumb img { width: 100%; height: 100%; object-fit: cover; }
  .noimg { font-size: 12px; color: #9a988f; }
  .info { padding: 10px 14px; width: 100%; }
  .info h3 { margin: 0 0 2px; font-size: 15px; }
  .meta { color: #6d6d66; font-size: 12.5px; margin: 0 0 6px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  td { padding: 3px 6px 3px 0; border-top: 1px solid #eeede8; }
  .chip { font-size: 11.5px; padding: 1px 8px; border-radius: 99px; white-space: nowrap; }
  .chip.verde { background: #e1f5ee; color: #085041; }
  .chip.ambar { background: #faeeda; color: #633806; }
  .chip.rojo { background: #fcebeb; color: #791f1f; }
  .chip.gris { background: #f1efe8; color: #444441; }
  .vacio { background: #fff; border: 1px dashed #c9c7bd; border-radius: 10px; padding: 26px; text-align: center; color: #6d6d66; }
  .salud table { background: #fff; border: 1px solid #dcdad2; border-radius: 10px; }
  .salud td { padding: 6px 12px; }
</style></head><body>
<header>
  <h1>StoreSync</h1>
  <span class="meta">datos de ${esc(HOST_DB)}</span>
  <span class="meta">webhooks sin procesar: ${pendientes ?? 0}</span>
  <span class="meta">actualizado ${esc(new Date().toLocaleTimeString("es", { hour12: false }))} · auto-refresh 30 s</span>
</header>
<main>
  <h2>Tiendas${shopFilter ? ` · <a href="/">ver todas</a>` : ""}</h2>
  <div class="tiendas">${shopCards || `<div class="vacio">Sin tiendas aún — corre el onboarding o la simulación (tests/simulacion_inbound.sh con KEEP=1)</div>`}</div>
  <h2>Productos sincronizados${shopFilter ? "" : " (todas las tiendas)"}</h2>
  ${prodCards ? `<div class="grid">${prodCards}</div>` : `<div class="vacio">Sin productos sincronizados todavía</div>`}
  <h2>Últimos eventos de sync</h2>
  <div class="salud"><table>${evFilas || `<tr><td class="meta">sin eventos aún</td></tr>`}</table></div>
</main>
</body></html>`;
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
    if (url.pathname !== "/") {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("no encontrado");
      return;
    }
    const html = await renderPage(url.searchParams.get("shop"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`error del panel: ${(e as Error).message}`);
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Panel de sincronización: http://127.0.0.1:${PORT} (datos de ${HOST_DB})`);
});
