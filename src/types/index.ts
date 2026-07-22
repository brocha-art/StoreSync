// Tipos compartidos entre servicios, workers y Edge Functions.

/** Fila que devuelve get_shop_credentials (migración 003). Solo en memoria: jamás loguear. */
export interface ShopCredentials {
  shop_domain: string;
  access_token: string;
  webhook_secret: string;
  location_id: string;
}

/** Mensaje encolado en pgmq 'sync_jobs' por el receptor de webhooks (Decisión 4). */
export interface SyncJobMessage {
  webhook_event_id: string;
  shop_id: string;
  topic: string;
}
