// Fuente de catálogo para el import inicial (guía §5).
// La interfaz existe para que Bulk Operations (§5.3) sea un swap, no un rewrite.

import {
  EXTRA_VARIANTS_QUERY,
  PRODUCTS_PAGE_QUERY,
  type ExtraVariantsData,
  type ProductNode,
  type ProductsPageData,
} from "../graphql/products.query.js";
import { numericId } from "./gid.js";
import { shopifyGraphql } from "./shopify-client.js";

export interface ImagenImportada {
  shopifyImageId: string | null;
  url: string;
  altText: string | null;
  position: number;
}

export interface VarianteImportada {
  shopifyVariantId: string; // numérico
  inventoryItemId: string; // numérico — OBLIGATORIO (§5, advertencia de la guía)
  sku: string | null;
  price: string | null;
}

export interface ProductoImportado {
  shopifyProductId: string; // numérico
  title: string | null;
  handle: string | null;
  descriptionHtml: string | null;
  status: string | null;
  images: ImagenImportada[];
  variants: VarianteImportada[];
}

export interface CatalogSource {
  /** Entrega el catálogo completo por páginas, con inventoryItem.id por variante. */
  fetchCatalog(): AsyncGenerator<ProductoImportado[]>;
}

const PAGE_SIZE = 25; // contiene el costo: 25 productos × 50 variantes + imágenes

/** Import paginado (§5.2) — adecuado para catálogos chicos/medianos. */
export class PaginatedCatalogSource implements CatalogSource {
  constructor(
    private readonly shopDomain: string,
    private readonly accessToken: string,
  ) {}

  async *fetchCatalog(): AsyncGenerator<ProductoImportado[]> {
    let cursor: string | null = null;
    do {
      const page: ProductsPageData = await shopifyGraphql<ProductsPageData>({
        shopDomain: this.shopDomain,
        accessToken: this.accessToken,
        query: PRODUCTS_PAGE_QUERY,
        variables: { cursor, pageSize: PAGE_SIZE },
      });

      const productos: ProductoImportado[] = [];
      for (const node of page.products.nodes) {
        productos.push(await this.mapProduct(node));
      }
      yield productos;

      cursor = page.products.pageInfo.hasNextPage ? page.products.pageInfo.endCursor : null;
    } while (cursor);
  }

  private async mapProduct(node: ProductNode): Promise<ProductoImportado> {
    // Variantes 51+: paginación anidada aparte (PENDIENTES #4)
    let variants = node.variants.nodes;
    let vCursor = node.variants.pageInfo.hasNextPage ? node.variants.pageInfo.endCursor : null;
    while (vCursor) {
      const extra: ExtraVariantsData = await shopifyGraphql<ExtraVariantsData>({
        shopDomain: this.shopDomain,
        accessToken: this.accessToken,
        query: EXTRA_VARIANTS_QUERY,
        variables: { productId: node.id, cursor: vCursor },
      });
      const conn = extra.product?.variants;
      if (!conn) break;
      variants = variants.concat(conn.nodes);
      vCursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    }

    // Imágenes: featuredImage primero (posición 0), resto en orden, dedupe por url
    const images: ImagenImportada[] = [];
    const seen = new Set<string>();
    if (node.featuredImage?.url) {
      images.push({
        shopifyImageId: null,
        url: node.featuredImage.url,
        altText: node.featuredImage.altText,
        position: 0,
      });
      seen.add(node.featuredImage.url);
    }
    for (const img of node.images.nodes) {
      if (seen.has(img.url)) continue;
      seen.add(img.url);
      images.push({
        shopifyImageId: numericId(img.id),
        url: img.url,
        altText: img.altText,
        position: images.length,
      });
    }

    return {
      shopifyProductId: numericId(node.id),
      title: node.title,
      handle: node.handle,
      descriptionHtml: node.descriptionHtml,
      status: node.status?.toLowerCase() ?? null,
      images,
      variants: variants.map((v) => ({
        shopifyVariantId: numericId(v.id),
        inventoryItemId: numericId(v.inventoryItem.id), // sin esto no hay outbound (§8)
        sku: v.sku,
        price: v.price,
      })),
    };
  }
}

/**
 * Camino listo para catálogos grandes (guía §5.3): Bulk Operations corre la
 * query server-side y devuelve un JSONL descargable, sin drenar el rate limit
 * normal. Implementación pendiente:
 *   1. bulkOperationRunQuery con la query de productos+variantes(+inventoryItem.id)
 *   2. poll de currentBulkOperation hasta COMPLETED (o webhook bulk_operations/finish)
 *   3. descargar el JSONL (url firmada), parsear líneas padre/hijo (__parentId)
 *   4. yield en lotes de ProductoImportado — el resto del import no cambia
 */
export class BulkCatalogSource implements CatalogSource {
  // eslint-disable-next-line require-yield
  async *fetchCatalog(): AsyncGenerator<ProductoImportado[]> {
    throw new Error(
      "BulkCatalogSource pendiente: usar PaginatedCatalogSource (el import lo usa por defecto). Ver guía §5.3.",
    );
  }
}
