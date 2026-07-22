// Verificación HMAC de webhooks de Shopify (guía §6.2).
// SIEMPRE sobre el body CRUDO (bytes sin parsear), comparación en tiempo
// constante con guard de longitud. Nunca ===.

import crypto from "node:crypto";
import { Buffer } from "node:buffer";

export function verifyWebhook(rawBody: string, hmacHeader: string, secret: string): boolean {
  const digest = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  const a = Buffer.from(digest);
  const b = Buffer.from(hmacHeader);
  // guard de longitud: timingSafeEqual lanza si los buffers difieren en tamaño
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
