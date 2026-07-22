// Registro de webhooks (guía §6.1). El topic del header X-Shopify-Topic usa
// forma "products/update"; el enum GraphQL usa PRODUCTS_UPDATE. En la base de
// datos siempre se guarda la forma del header.

/** Topics de la guía §6.1, en forma de enum GraphQL. */
export const WEBHOOK_TOPICS = [
  "PRODUCTS_CREATE",
  "PRODUCTS_UPDATE",
  "PRODUCTS_DELETE",
  "INVENTORY_LEVELS_UPDATE",
  "ORDERS_CREATE",
  "ORDERS_PAID",
  "ORDERS_CANCELLED",
  "FULFILLMENTS_UPDATE",
] as const;

export type WebhookTopic = (typeof WEBHOOK_TOPICS)[number];

export const LIST_WEBHOOKS_QUERY = /* GraphQL */ `
  query ListWebhooks($cursor: String) {
    webhookSubscriptions(first: 100, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        topic
        endpoint {
          __typename
          ... on WebhookHttpEndpoint {
            callbackUrl
          }
        }
      }
    }
  }
`;

export interface ListWebhooksData {
  webhookSubscriptions: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<{
      id: string;
      topic: string;
      endpoint: { __typename: string; callbackUrl?: string };
    }>;
  };
}

export const CREATE_WEBHOOK_MUTATION = /* GraphQL */ `
  mutation RegisterWebhook($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
      webhookSubscription {
        id
        topic
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export interface CreateWebhookData {
  webhookSubscriptionCreate: {
    webhookSubscription: { id: string; topic: string } | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  };
}
