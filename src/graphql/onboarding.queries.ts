// Queries usadas por la validación de onboarding (guía §2.2).

export const SHOP_QUERY = /* GraphQL */ `
  query ShopInfo {
    shop {
      name
      myshopifyDomain
    }
  }
`;

export interface ShopQueryData {
  shop: { name: string; myshopifyDomain: string };
}

export const LOCATIONS_QUERY = /* GraphQL */ `
  query Locations {
    locations(first: 250, includeInactive: true) {
      nodes {
        id
        name
        isActive
      }
    }
  }
`;

export interface LocationsQueryData {
  locations: { nodes: Array<{ id: string; name: string; isActive: boolean }> };
}

export const TRACKING_SAMPLE_QUERY = /* GraphQL */ `
  query TrackingSample {
    productVariants(first: 50) {
      nodes {
        id
        inventoryItem {
          id
          tracked
        }
      }
    }
  }
`;

export interface TrackingSampleData {
  productVariants: {
    nodes: Array<{ id: string; inventoryItem: { id: string; tracked: boolean } }>;
  };
}
