import { shopifyGraphqlUrl } from "../config/shopify.js";

/** 401/403: JAMÁS se reintenta (§10). El caller marca la tienda needs_reauth y detiene sus jobs. */
export class ShopifyAuthError extends Error {
  constructor(
    readonly status: number,
    shopDomain: string,
  ) {
    super(`Autenticación rechazada por Shopify (${status}) para ${shopDomain}`);
    this.name = "ShopifyAuthError";
  }
}

/** Errores GraphQL que no son throttling (query inválida, etc.). Los userErrors de mutaciones se manejan en el call site. */
export class ShopifyGraphqlError extends Error {
  constructor(readonly messages: string[]) {
    super(`GraphQL: ${messages.join("; ")}`);
    this.name = "ShopifyGraphqlError";
  }
}

interface GraphqlError {
  message: string;
  extensions?: { code?: string };
}

interface GraphqlEnvelope<T> {
  data?: T;
  errors?: GraphqlError[];
  extensions?: {
    cost?: {
      requestedQueryCost: number;
      throttleStatus: { currentlyAvailable: number; restoreRate: number };
    };
  };
}

const MAX_ATTEMPTS = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Único camino para hablar con la Admin GraphQL API.
 * - Versión de API SIEMPRE desde src/config/shopify.ts (Decisión 1).
 * - 429 / 5xx: backoff exponencial honrando Retry-After; tope de intentos (§10).
 * - THROTTLED (rate limit por costo, leaky bucket): espera calculada con
 *   requestedQueryCost vs currentlyAvailable/restoreRate (§10).
 * - 401/403: ShopifyAuthError inmediato, sin reintento (§10).
 * - El token vive solo en memoria durante el request: jamás se loguea.
 */
export async function shopifyGraphql<T>(opts: {
  shopDomain: string;
  accessToken: string;
  query: string;
  variables?: Record<string, unknown>;
}): Promise<T> {
  const url = shopifyGraphqlUrl(opts.shopDomain);

  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": opts.accessToken,
      },
      body: JSON.stringify({ query: opts.query, variables: opts.variables ?? {} }),
    });

    if (res.status === 401 || res.status === 403) {
      throw new ShopifyAuthError(res.status, opts.shopDomain);
    }

    if (res.status === 429 || res.status >= 500) {
      if (attempt >= MAX_ATTEMPTS) {
        throw new Error(`Shopify ${res.status} tras ${attempt} intentos (${opts.shopDomain})`);
      }
      const retryAfter = Number(res.headers.get("Retry-After"));
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 1000;
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) {
      throw new Error(`Shopify respondió ${res.status} (${opts.shopDomain})`);
    }

    const body = (await res.json()) as GraphqlEnvelope<T>;

    if (body.errors && body.errors.length > 0) {
      const throttled = body.errors.some((e) => e.extensions?.code === "THROTTLED");
      if (throttled && attempt < MAX_ATTEMPTS) {
        const cost = body.extensions?.cost;
        const waitMs = cost
          ? Math.ceil(
              Math.max(cost.requestedQueryCost - cost.throttleStatus.currentlyAvailable, 0) /
                cost.throttleStatus.restoreRate,
            ) *
              1000 +
            250
          : 2 ** attempt * 1000;
        await sleep(waitMs);
        continue;
      }
      throw new ShopifyGraphqlError(body.errors.map((e) => e.message));
    }

    if (body.data === undefined) {
      throw new ShopifyGraphqlError(["Respuesta sin data ni errors"]);
    }
    return body.data;
  }
}
