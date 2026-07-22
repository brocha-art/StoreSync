// Queries del import inicial (guía §5.2, corregida: SIEMPRE con
// inventoryItem { id } — sin él no hay escrituras outbound §8).
//
// Nota (§5.1 paso 4): el available se pide POR LOCATION en una segunda fase
// (INVENTORY_BATCH_QUERY); el inventoryQuantity del §5.2 es el agregado de
// todas las locations y no sirve para inventory_levels(variant, location).

export const PRODUCTS_PAGE_QUERY = /* GraphQL */ `
  query ProductsPage($cursor: String, $pageSize: Int!) {
    products(first: $pageSize, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        title
        handle
        descriptionHtml
        status
        featuredImage {
          url
          altText
        }
        images(first: 50) {
          nodes {
            id
            url
            altText
          }
        }
        variants(first: 50) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            sku
            price
            inventoryItem {
              id
            }
          }
        }
      }
    }
  }
`;

export interface VariantNode {
  id: string;
  sku: string | null;
  price: string | null;
  inventoryItem: { id: string };
}

export interface ProductNode {
  id: string;
  title: string | null;
  handle: string | null;
  descriptionHtml: string | null;
  status: string | null;
  featuredImage: { url: string; altText: string | null } | null;
  images: { nodes: Array<{ id: string; url: string; altText: string | null }> };
  variants: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: VariantNode[];
  };
}

export interface ProductsPageData {
  products: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: ProductNode[];
  };
}

/** Variantes 51+ de un producto (catálogos con variantes masivas — PENDIENTES #4). */
export const EXTRA_VARIANTS_QUERY = /* GraphQL */ `
  query ExtraVariants($productId: ID!, $cursor: String) {
    product(id: $productId) {
      variants(first: 100, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          sku
          price
          inventoryItem {
            id
          }
        }
      }
    }
  }
`;

export interface ExtraVariantsData {
  product: {
    variants: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: VariantNode[];
    };
  } | null;
}

/** Fase 2: available por item EN la location primaria, en lotes por ids. */
export const INVENTORY_BATCH_QUERY = /* GraphQL */ `
  query InventoryBatch($ids: [ID!]!, $locationId: ID!) {
    nodes(ids: $ids) {
      __typename
      ... on InventoryItem {
        id
        inventoryLevel(locationId: $locationId) {
          quantities(names: ["available"]) {
            name
            quantity
          }
        }
      }
    }
  }
`;

export interface InventoryBatchData {
  nodes: Array<{
    __typename: string;
    id?: string;
    inventoryLevel?: {
      quantities: Array<{ name: string; quantity: number }>;
    } | null;
  } | null>;
}

export const PRODUCTS_COUNT_QUERY = /* GraphQL */ `
  query ProductsCount {
    productsCount {
      count
    }
  }
`;

export interface ProductsCountData {
  productsCount: { count: number } | null;
}
